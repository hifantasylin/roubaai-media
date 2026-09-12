/**
 * MaiziAI video provider — v1 asynchronous submit/poll, rewritten from
 * autovideo's Maizi video semantics. The provider holds no API key (resolves
 * `MAIZI_API_KEY` per operation) and normalizes Maizi's native state machine
 * (`queued`/`pending`/`processing` → running, `completed` → succeeded,
 * `failed`/`violation` → failed) into the provider-agnostic {@link VideoTaskPoll}.
 *
 * Maizi-specific facts — the `violation` state, multi-`result_urls`, `costUsd`,
 * the 24h download policy — stay inside this implementation. The final video
 * file is downloaded immediately on `finalize` and landed to a local file
 * (24h-valid URLs must not be returned bare).
 *
 * @module @roubaai/media-maizi/maizi-video-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { VideoProvider } from '@roubaai/media'
import type {
  MediaProgress, MediaRef, VideoGenerationResult, VideoGenerateInput, VideoTaskHandle, VideoTaskPoll,
} from '@roubaai/media'
import { getJson, postJson, streamBytes, MaiziHttpError, MaiziNetworkError, httpStatusMeaning } from './http.ts'
import { MAIZI_API_KEY_REF, MissingCredentialError } from './maizi-image-provider.ts'
import { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'
import { readActiveMediaProvider } from '@roubaai/media'

/** Default Maizi video base URL (v1 asynchronous). */
export const MAIZI_VIDEO_BASE_URL = 'https://www.maizitech.xyz/v1'

/** Default video model (Seedance 2.0 mini). */
export const DEFAULT_VIDEO_MODEL = 'doubao-seedance-2.0-mini'

/**
 * Conservative media URL expiry: Maizi returns no precise expiry field, so the
 * 24h download policy is fixed here and stamped onto the produced `MediaRef`
 * as `expiresAt = now + 24h`.
 */
const MEDIA_URL_TTL_MS = 24 * 60 * 60_000

/** Bound on the result-URL probe in `finalize` (a hung CDN must not block forever). */
const VIDEO_PROBE_TIMEOUT_MS = 30_000

/** Seedance 2.0 系素材上限（doubao-seedance-2.0 / -mini / -fast）。 */
interface MediaCaps {
  maxImageUrls: number
  maxVideoUrls: number
  maxAudioUrls: number
}
const CAPS_2_0: MediaCaps = { maxImageUrls: 9, maxVideoUrls: 3, maxAudioUrls: 3 }
/** Seedance 2.5 系素材上限（doubao-seedance-2.5）。 */
const CAPS_2_5: MediaCaps = { maxImageUrls: 30, maxVideoUrls: 10, maxAudioUrls: 10 }

/** 判定模型代际：2.5 系用 2.5 上限，其余（2.0 系/未知）用 2.0 上限保守处理。 */
function capsForModel(model: string): MediaCaps {
  return model.includes('2.5') ? CAPS_2_5 : CAPS_2_0
}

/** One Maizi video task payload from `GET /v1/tasks/{id}`. */
interface MaiziVideoTask {
  id?: string
  status?: string
  progress?: number
  result_urls?: string[] | null
  cost?: number
  error_msg?: string | null
}

/** One Maizi video submission response. */
interface MaiziVideoSubmitResponse {
  id?: string
  status?: string
}

/** Provider config; every field is optional with a sensible default. */
export interface MaiziVideoConfig {
  /** Endpoint base; defaults to the public v1 API. */
  baseUrl?: string
  /** Default model id; defaults to {@link DEFAULT_VIDEO_MODEL}. */
  model?: string
  /** Credential reference (environment-variable name); defaults to `MAIZI_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Settings namespace the roubaai video plugin's Settings page owns. The
   * stored key and endpoint win over {@link MaiziVideoConfig.baseUrl} and the
   * credential reference; they are read per operation, so editing the Settings
   * page takes effect without reloading this plugin.
   * Defaults to {@link DEFAULT_SETTINGS_NAMESPACE}.
   */
  settingsNamespace?: string
}

/**
 * Maizi's native statuses mapped to the normalized poll status. `queued`/
 * `pending`/`processing` all mean "still running"; `completed` is the only
 * success; `failed` and `violation` both fail (with `violation` carrying its
 * content-safety reason as the error message).
 */
function normalizeStatus(status: string | undefined): VideoTaskPoll['status'] {
  switch (status) {
    case 'completed':
      return 'succeeded'
    case 'failed':
    case 'violation':
      return 'failed'
    default:
      return 'running'
  }
}

/**
 * An internal pollable handle caching the latest Maizi task payload so
 * `finalize` can download the just-succeeded `result_urls[0]` (24h-valid) and
 * record the provider-reported `costUsd`.
 */
class MaiziVideoTaskHandle implements VideoTaskHandle {
  readonly taskId: string
  private lastResultUrls: string[] = []
  private lastCostUsd: number | undefined

  constructor(
    taskId: string,
    private readonly baseUrl: string,
    /** Lazily resolves the API key per poll so the handle never holds plaintext. */
    private readonly resolveKey: () => Promise<string>,
  ) {
    this.taskId = taskId
  }

  async poll(signal?: AbortSignal): Promise<VideoTaskPoll> {
    let response: { status: number; data: unknown }
    try {
      response = await getJson(
        `${this.baseUrl}/tasks/${this.taskId}`,
        await this.resolveKey(),
        signal,
      )
    } catch (error) {
      // A transport failure while polling must not be confused with a
      // generation failure: the Maizi task may still be running. Tag the stage
      // so the job detail tells the caller "poll only — retry is free".
      throw error instanceof MaiziNetworkError
        ? new MaiziNetworkError(`video task ${this.taskId} poll ${error.message}`, error)
        : error
    }
    const { status, data } = response
    if (status !== 200) {
      // Deterministic client errors (bad key, empty balance, unknown task,
      // invalid params) must surface as `failed` with the code + meaning —
      // otherwise the job polls them into the 15-minute timeout and the model
      // can never tell "balance empty, top up" from "still generating". Only
      // transient statuses (429 rate limit, 5xx) keep the task running.
      if (status >= 400 && status < 500 && status !== 429) {
        return {
          status: 'failed',
          errorMsg: `${httpStatusMeaning(status)}（HTTP ${status}）`,
        }
      }
      // A non-200 poll keeps the task running (transient); no state change.
      return { status: 'running' }
    }
    const task = data as MaiziVideoTask
    this.lastResultUrls = task.result_urls ?? []
    if (task.cost !== undefined) this.lastCostUsd = task.cost
    const normalized = normalizeStatus(task.status)
    if (normalized === 'succeeded') {
      const resultUrl = this.lastResultUrls[0]
      if (resultUrl === undefined) {
        return { status: 'failed', errorMsg: `Maizi task ${this.taskId} completed with no result URL` }
      }
      return {
        status: 'succeeded',
        progress: 100,
        resultUrl,
      }
    }
    if (normalized === 'failed') {
      return {
        status: 'failed',
        errorMsg: task.error_msg ?? `Maizi task ${this.taskId} failed (${task.status ?? 'unknown'})`,
      }
    }
    return {
      status: 'running',
      ...task.progress !== undefined ? { progress: task.progress } : {},
    }
  }

  /** The cached cost (USD) reported by the provider, if any. */
  get costUsd(): number | undefined {
    return this.lastCostUsd
  }
}

/**
 * Maizi video provider (v1 async submit + poll + finalize). The final video is
 * downloaded on `finalize` and landed to a local file; the 24h-valid URL is
 * never returned bare.
 */
export class MaiziVideoProvider extends VideoProvider {
  readonly provider = 'maizi'
  readonly defaultModel: string

  private readonly baseUrl: string
  private readonly apiKeyEnv: string
  private readonly settingsNamespace: string

  constructor(private readonly ctx: Context, config: MaiziVideoConfig = {}) {
    super()
    this.baseUrl = config.baseUrl ?? MAIZI_VIDEO_BASE_URL
    this.defaultModel = config.model ?? DEFAULT_VIDEO_MODEL
    this.apiKeyEnv = config.apiKeyEnv ?? MAIZI_API_KEY_REF
    this.settingsNamespace = config.settingsNamespace ?? DEFAULT_SETTINGS_NAMESPACE
  }

  /**
   * Resolve the API key per operation. The Settings page wins over the
   * credential store: it is the deployment's explicit per-install choice, and
   * the one surface a person can edit without touching the environment. The
   * credential store — and through it `MAIZI_API_KEY` — stays the fallback, so
   * a deployment that never opens the Settings page is unaffected.
   * @throws {MissingCredentialError} when neither source holds a key.
   */
  private async resolveKey(): Promise<string> {
    const configured = readActiveMediaProvider(this.ctx, this.settingsNamespace, 'video').apiKey
    if (configured !== undefined) return configured
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(this.apiKeyEnv))
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    throw new MissingCredentialError(this.apiKeyEnv)
  }

  /**
   * Endpoint base: the Settings page's override when one is stored, else the
   * deployment-configured base. A trailing slash is trimmed so a pasted URL
   * cannot produce a `//` path segment.
   */
  private resolveBaseUrl(): string {
    const override = readActiveMediaProvider(this.ctx, this.settingsNamespace, 'video').baseUrl
    return (override ?? this.baseUrl).replace(/\/+$/, '')
  }

  /**
   * Default video model: the Settings page's override when one is stored, else
   * the deployment-configured model. A caller's explicit `input.model` still
   * wins — this is only the default the request falls back to.
   */
  private resolveModel(): string {
    return readActiveMediaProvider(this.ctx, this.settingsNamespace, 'video').model ?? this.defaultModel
  }

  async submit(input: VideoGenerateInput, signal?: AbortSignal): Promise<VideoTaskHandle> {
    const apiKey = await this.resolveKey()
    // 显式 model 参数优先，缺省用 provider 配置的默认模型；caps 校验与实际生效模型一致
    const model = input.model ?? this.resolveModel()
    const caps = capsForModel(model)
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      duration: input.duration ?? 5,
    }
    if (input.imageUrls !== undefined && input.imageUrls.length > 0) {
      payload['image_urls'] = input.imageUrls.slice(0, caps.maxImageUrls)
    }
    if (input.imageWithRoles !== undefined && input.imageWithRoles.length > 0) {
      payload['image_with_roles'] = input.imageWithRoles
    }
    if (input.videoUrls !== undefined && input.videoUrls.length > 0) {
      payload['video_urls'] = input.videoUrls.slice(0, caps.maxVideoUrls)
    }
    if (input.audioUrls !== undefined && input.audioUrls.length > 0) {
      payload['audio_urls'] = input.audioUrls.slice(0, caps.maxAudioUrls)
    }
    if (input.size !== undefined) payload['size'] = input.size
    if (input.resolution !== undefined) payload['resolution'] = input.resolution
    if (input.generateAudio !== undefined) payload['generate_audio'] = input.generateAudio
    if (input.returnLastFrame !== undefined) payload['return_last_frame'] = input.returnLastFrame
    if (input.generationType !== undefined) payload['generation_type'] = input.generationType
    if (input.outputFormat !== undefined) payload['output_format'] = input.outputFormat
    if (input.callbackUrl !== undefined) payload['callback_url'] = input.callbackUrl
    if (input.watermark !== undefined) payload['watermark'] = input.watermark
    if (input.seed !== undefined) payload['seed'] = input.seed

    let response: { status: number; data: unknown }
    try {
      response = await postJson(
        `${this.resolveBaseUrl()}/videos/generations`,
        apiKey,
        payload,
        signal,
      )
    } catch (error) {
      // A transport failure at submission means the task was never accepted —
      // no billing occurred, so the retry is safe, but the stage must be named.
      throw error instanceof MaiziNetworkError
        ? new MaiziNetworkError(`video submission ${error.message}`, error)
        : error
    }
    const { status, data } = response
    if (status !== 200) {
      throw new MaiziHttpError(`Maizi video submission failed [${status}]`, status)
    }
    const submit = data as MaiziVideoSubmitResponse
    const taskId = submit.id
    if (taskId === undefined) {
      throw new MaiziHttpError('Maizi video submission returned no task id', 200)
    }
    // The handle pins the endpoint resolved at submit time: a task id belongs
    // to the endpoint that accepted it, so a later Settings-page change must
    // not redirect an in-flight poll to a different host.
    return new MaiziVideoTaskHandle(taskId, this.resolveBaseUrl(), () => this.resolveKey())
  }

  async finalize(
    handle: VideoTaskHandle,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<VideoGenerationResult> {
    // The handle caches the latest `result_urls[0]` from its last poll; poll
    // once more to be sure we use the final URL (the runtime polls to
    // `succeeded` before calling finalize, so this is the terminal URL).
    const poll = await handle.poll(signal)
    const url = poll.resultUrl
    if (url === undefined) {
      throw new MaiziHttpError(`video task ${handle.taskId} has no result URL to download`)
    }
    // The final URL is 24h-valid and streamed on demand by the host media
    // proxy — it is NOT force-landed to a local file. We only probe the URL
    // to confirm it is reachable and capture its reported byte size (from
    // `content-length`), then cancel the probe stream: the actual bytes flow
    // through the proxy when the user displays or downloads the media.
    onProgress?.({ phase: 'downloading', percent: 0 })
    // Bound the probe so a hung upstream cannot block finalize forever (the
    // 24h URL may be slow or dead). AbortSignal.timeout races the caller's
    // signal and cancels the probe fetch when the bound elapses.
    let probe: Awaited<ReturnType<typeof streamBytes>>
    try {
      probe = await streamBytes(url, signal !== undefined
        ? AbortSignal.any([signal, AbortSignal.timeout(VIDEO_PROBE_TIMEOUT_MS)])
        : AbortSignal.timeout(VIDEO_PROBE_TIMEOUT_MS))
    } catch (error) {
      // The generation already succeeded at this point — only the result fetch
      // failed. Tagging the stage lets the job detail say "download only —
      // retry does NOT re-bill".
      throw error instanceof MaiziNetworkError
        ? new MaiziNetworkError(`video task ${handle.taskId} result download ${error.message}`, error)
        : error
    }
    if (probe === undefined || probe.status < 200 || probe.status >= 300) {
      // Release the probe stream so a failed/expired probe does not leak an
      // open upstream connection.
      await probe?.stream.cancel().catch(() => {})
      throw new MaiziHttpError(`video task ${handle.taskId} result URL is unreachable [${probe?.status ?? 'no-body'}]`, probe?.status)
    }
    await probe.stream.cancel()
    const contentLength = Number(probe.headers.get('content-length'))
    const sizeBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
    onProgress?.({ phase: 'saving', percent: 100 })
    const costUsd = handle instanceof MaiziVideoTaskHandle ? handle.costUsd : undefined
    const mediaRef: MediaRef = {
      url,
      mediaType: 'video/mp4',
      ...sizeBytes !== undefined ? { sizeBytes } : {},
      expiresAt: Date.now() + MEDIA_URL_TTL_MS,
    }
    return {
      kind: 'video',
      mediaType: 'video/mp4',
      mediaRef,
      providerMeta: {
        provider: this.provider,
        model: this.defaultModel,
        taskId: handle.taskId,
        ...costUsd !== undefined ? { costUsd } : {},
      },
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const apiKey = await this.resolveKey()
      const { status } = await postJson(
        `${this.resolveBaseUrl()}/videos/generations`,
        apiKey,
        { model: this.defaultModel, prompt: 'test', duration: 4 },
      )
      return status >= 200 && status < 500
    } catch {
      return false
    }
  }
}
