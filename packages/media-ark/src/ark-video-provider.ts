/**
 * Volcengine Ark video provider — the vendor's own asynchronous task API
 * (`POST {base}/contents/generations/tasks`, polled through
 * `GET {base}/contents/generations/tasks/{id}`).
 *
 * This adapter calls Ark directly with a deployment's own `ARK_API_KEY`. Ark's
 * request body is a multimodal `content` array rather than a flat prompt plus
 * image list, so the mapping from the seam's provider-neutral input lives here:
 * reference images, videos, and audio each become one typed entry, and the
 * caller's explicit role intent (`first_frame` / `last_frame` /
 * `reference_image`) passes through unchanged.
 *
 * Ark prices in RMB per second with vendor-specific discounts and tiers, so
 * this adapter reports no USD estimate. The ledger then records the run without
 * a figure rather than converting at a rate this package does not own.
 * @module @roubaai/media-ark/ark-video-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { VideoProvider, readActiveMediaProvider } from '@roubaai/media'
import type {
  MediaModelInfo, MediaProgress, MediaRef, ProviderProbeDraft, ProviderProbeResult, VideoCaps, VideoGenerationResult,
  VideoGenerateInput, VideoTaskHandle, VideoTaskPoll,
} from '@roubaai/media'
import {
  arkErrorDetail, arkStatusMeaning, ArkHttpError, ArkNetworkError, getJson, isModelNotFound, isNetworkError,
  postJson, probeResult,
} from './http.ts'
import { fetchArkModels, formatModelIds } from './ark-models.ts'
import { arkUnconfiguredReason, resolveArkKey } from './credentials.ts'
import { MissingCredentialError } from './errors.ts'
import { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'

export { MissingCredentialError } from './errors.ts'

/** Ark's public API base (cn-beijing region). */
export const ARK_VIDEO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** Credential reference for the Ark API key. */
export const ARK_API_KEY_REF = 'ARK_API_KEY'

/**
 * Fallback model. Callers name a model on every request, so this only backs
 * `caps()` and the connectivity probe; it is Ark's Seedance 2.0 mini id — the
 * 1.5 pro id this used to carry is listed as Retiring by the vendor catalogue.
 */
export const DEFAULT_VIDEO_MODEL = 'doubao-seedance-2-0-mini-260615'

/**
 * Conservative result-URL lifetime. Ark states no expiry for the produced file,
 * so the 24h download policy the other adapters use is applied here too.
 */
const MEDIA_URL_TTL_MS = 24 * 60 * 60_000

/** Bound on the result-URL probe in `finalize` (a hung CDN must not block forever). */
const VIDEO_PROBE_TIMEOUT_MS = 30_000

/**
 * Per-generation bounds. Ark's model ids embed the generation
 * (`doubao-seedance-2-0-mini-260615`), so the match is on that fragment; an id
 * matching none takes the most conservative set, which rejects an oversized
 * request before it is billed.
 */
const CAPS_BY_GENERATION: ReadonlyArray<{ readonly generation: RegExp; readonly caps: VideoCaps }> = [
  {
    generation: /seedance[-_.]?2[-_.]?5/,
    caps: { minDuration: 4, maxDuration: 30, maxImageUrls: 30, maxVideoUrls: 10, maxAudioUrls: 10 },
  },
  {
    generation: /seedance[-_.]?2[-_.]?0/,
    caps: { minDuration: 4, maxDuration: 15, maxImageUrls: 9, maxVideoUrls: 3, maxAudioUrls: 3 },
  },
  {
    generation: /seedance[-_.]?1[-_.]?5/,
    caps: { minDuration: 4, maxDuration: 12, maxImageUrls: 2, maxVideoUrls: 0, maxAudioUrls: 0 },
  },
]

/** The most conservative set Ark accepts, for an id this adapter cannot place. */
const CONSERVATIVE_CAPS: VideoCaps = { minDuration: 2, maxDuration: 12, maxImageUrls: 2, maxVideoUrls: 0, maxAudioUrls: 0 }

/** One entry of Ark's multimodal request. */
type ArkContentPart =
  | { type: 'text', text: string }
  | { type: 'image_url', image_url: { url: string }, role?: string }
  | { type: 'video_url', video_url: { url: string }, role: 'reference_video' }
  | { type: 'audio_url', audio_url: { url: string }, role: 'reference_audio' }

/** The task payload `GET /contents/generations/tasks/{id}` answers. */
interface ArkTask {
  id?: string
  status?: string
  content?: { video_url?: string } | null
  error?: { code?: string, message?: string } | null
}

/** The task-creation response: Ark answers the new task's id. */
interface ArkSubmitResponse {
  id?: string
}

/** Provider config; every field is optional with a sensible default. */
export interface ArkVideoConfig {
  /** Endpoint base; defaults to {@link ARK_VIDEO_BASE_URL}. */
  baseUrl?: string
  /** Default model id; defaults to {@link DEFAULT_VIDEO_MODEL}. */
  model?: string
  /** Credential reference (environment-variable name); defaults to `ARK_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Settings namespace the roubaai Settings page owns. The key, endpoint, and
   * model a user stores there win over this config; they are read per
   * operation, so editing the page takes effect without reloading the plugin.
   */
  settingsNamespace?: string
}

/** Ark's status vocabulary mapped onto the normalized poll status. */
function normalizeStatus(status: string | undefined): VideoTaskPoll['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
    case 'expired':
      return 'failed'
    // `queued` and `running` both mean the task has not settled yet.
    default:
      return 'running'
  }
}

/** Map the seam's generation mode onto Ark's task-type hint, when one applies. */
function arkTaskType(generationType: string | undefined): string | undefined {
  switch (generationType) {
    case 'reference':
      return 'reference'
    case 'video_edit':
      return 'edit'
    default:
      return undefined
  }
}

/** Read one reference image URL out of a role-tagged entry. */
function imageUrlOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const raw = record['image_url'] ?? record['url']
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const nested = (raw as Record<string, unknown>)['url']
    return typeof nested === 'string' ? nested : undefined
  }
  return undefined
}

/** Read the role of a role-tagged entry, when it carries one. */
function roleOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const role = (entry as Record<string, unknown>)['role']
  return typeof role === 'string' && role.length > 0 ? role : undefined
}

/**
 * Build Ark's `content` array from the seam's provider-neutral input. Ark needs
 * a role to place more than one image, so a lone `imageUrls` entry becomes the
 * first frame and a set of them becomes reference images; a caller that means
 * first-plus-last frame or a mixture says so through `imageWithRoles`, whose
 * roles pass through verbatim.
 * @param input - the provider-neutral generation input.
 * @returns the ordered content entries.
 */
function buildContent(input: VideoGenerateInput): ArkContentPart[] {
  const parts: ArkContentPart[] = []
  if (input.prompt.trim().length > 0) parts.push({ type: 'text', text: input.prompt })

  const tagged = input.imageWithRoles ?? []
  if (tagged.length > 0) {
    for (const entry of tagged) {
      const url = imageUrlOf(entry)
      if (url === undefined) continue
      const role = roleOf(entry)
      parts.push({ type: 'image_url', image_url: { url }, ...(role === undefined ? {} : { role }) })
    }
  } else {
    const urls = input.imageUrls ?? []
    for (const url of urls) {
      const role = urls.length === 1 ? 'first_frame' : 'reference_image'
      parts.push({ type: 'image_url', image_url: { url }, role })
    }
  }

  for (const url of input.videoUrls ?? []) {
    parts.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  }
  for (const url of input.audioUrls ?? []) {
    parts.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  }
  return parts
}

/** The model bounds an Ark id falls under. */
function capsForModel(model: string): VideoCaps {
  for (const entry of CAPS_BY_GENERATION) {
    if (entry.generation.test(model)) return entry.caps
  }
  return CONSERVATIVE_CAPS
}

/**
 * A pollable handle caching the terminal `content.video_url` so `finalize` can
 * probe it, plus the model the task was submitted with (Ark echoes no model on
 * the task, and the result must name what actually ran).
 */
class ArkTaskHandle implements VideoTaskHandle {
  readonly taskId: string
  readonly model: string

  constructor(
    taskId: string,
    model: string,
    private readonly baseUrl: string,
    private readonly resolveKey: () => Promise<string>,
  ) {
    this.taskId = taskId
    this.model = model
  }

  async poll(signal?: AbortSignal): Promise<VideoTaskPoll> {
    let response: { status: number, data: unknown }
    try {
      response = await getJson(
        `${this.baseUrl}/contents/generations/tasks/${this.taskId}`,
        await this.resolveKey(),
        signal,
      )
    } catch (error) {
      // A transport failure while polling must not read as a generation
      // failure: the Ark task may still be running, and re-polling is free.
      throw isNetworkError(error)
        ? new ArkNetworkError(`Ark task ${this.taskId} poll ${error.message}`, error)
        : error
    }
    const { status, data } = response
    if (status !== 200) {
      // A deterministic client error (bad key, unknown task, denied model) must
      // fail now — polling it into the timeout would leave the model unable to
      // tell "fix the key" from "still generating". Only 429 and 5xx stay
      // running.
      if (status >= 400 && status < 500 && status !== 429) {
        return { status: 'failed', errorMsg: `${arkStatusMeaning(status)}（HTTP ${status}）` }
      }
      return { status: 'running' }
    }
    const task = data as ArkTask
    const normalized = normalizeStatus(task.status)
    if (normalized === 'succeeded') {
      const videoUrl = task.content?.video_url
      if (typeof videoUrl !== 'string' || videoUrl.length === 0) {
        return { status: 'failed', errorMsg: `Ark task ${this.taskId} succeeded without a video_url` }
      }
      return { status: 'succeeded', progress: 100, resultUrl: videoUrl }
    }
    if (normalized === 'failed') {
      const reported = task.error?.message ?? task.error?.code
      return { status: 'failed', errorMsg: reported ?? `Ark task ${this.taskId} failed (${task.status ?? 'unknown'})` }
    }
    return { status: 'running' }
  }
}

/**
 * Volcengine Ark video provider. Submission creates one asynchronous task; the
 * background job polls it and `finalize` probes the produced file.
 */
export class ArkVideoProvider extends VideoProvider {
  readonly provider = 'ark'
  readonly defaultModel: string

  private readonly baseUrl: string
  private readonly apiKeyEnv: string
  private readonly settingsNamespace: string

  constructor(private readonly ctx: Context, config: ArkVideoConfig = {}) {
    super()
    this.baseUrl = config.baseUrl ?? ARK_VIDEO_BASE_URL
    this.defaultModel = config.model ?? DEFAULT_VIDEO_MODEL
    this.apiKeyEnv = config.apiKeyEnv ?? ARK_API_KEY_REF
    this.settingsNamespace = config.settingsNamespace ?? DEFAULT_SETTINGS_NAMESPACE
  }

  /**
   * Resolve the API key per operation. The Settings page wins over the
   * credential store: it is the deployment's explicit per-install choice and
   * the one surface a person can edit without touching the environment. The
   * credential store — and through it `ARK_API_KEY` — stays the fallback, so a
   * deployment that never opens the Settings page is unaffected.
   * @returns the resolved key.
   * @throws {MissingCredentialError} when no source holds a key.
   */
  private async resolveKey(): Promise<string> {
    const key = await this.probeKey('')
    if (key === undefined) throw new MissingCredentialError(this.apiKeyEnv)
    return key
  }

  /**
   * The key a probe should present, or `undefined` when this deployment has
   * none anywhere. `undefined` is not an error here: it is the whole difference
   * between "nothing is configured yet" and "the backend refused what we sent".
   * @param draftKey - a key the configuration form holds but has not saved.
   * @returns the key to present, or `undefined` when nothing is configured.
   */
  private async probeKey(draftKey: string): Promise<string | undefined> {
    return await resolveArkKey(this.ctx, this.settingsNamespace, 'video', this.apiKeyEnv, draftKey)
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
   * Default model: the Settings page's override when one is stored, else the
   * deployment-configured model. A caller's explicit `input.model` still wins.
   */
  private resolveModel(): string {
    return readActiveMediaProvider(this.ctx, this.settingsNamespace, 'video').model ?? this.defaultModel
  }

  caps(model?: string): VideoCaps {
    return capsForModel(model ?? this.resolveModel())
  }

  /**
   * List the video models this deployment may request. Ark reports each model's
   * capability as `task_type`, which is what separates a video id from an image
   * one in a catalogue that carries both.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the video models Ark reports, in Ark's order.
   * @throws {ArkHttpError} when Ark answers a non-200.
   */
  override async listModels(signal?: AbortSignal): Promise<MediaModelInfo[]> {
    const apiKey = await this.resolveKey()
    return await fetchArkModels(this.resolveBaseUrl(), apiKey, { taskType: 'Video' }, signal)
  }

  /**
   * List the video models for the endpoint and key a configuration form holds,
   * so a key that has not been saved yet can still browse the catalogue. An
   * empty draft field falls back to the configured value, exactly as
   * {@link probe} does.
   * @param draft - the endpoint and key the form holds.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the video models Ark reports, in Ark's order.
   */
  override async listModelsWithDraft(draft: ProviderProbeDraft, signal?: AbortSignal): Promise<MediaModelInfo[]> {
    const base = draft.baseUrl.trim() === ''
      ? this.resolveBaseUrl()
      : draft.baseUrl.trim().replace(/\/+$/, '')
    const apiKey = draft.apiKey.trim() === '' ? await this.resolveKey() : draft.apiKey.trim()
    return await fetchArkModels(base, apiKey, { taskType: 'Video' }, signal)
  }

  /**
   * Ark bills in RMB per second, so this adapter states no USD figure; the
   * ledger records the run unpriced instead of converting at a rate it does
   * not own.
   * @returns always `undefined`.
   */
  estimateCostUsd(): number | undefined {
    return undefined
  }

  async submit(input: VideoGenerateInput, signal?: AbortSignal): Promise<VideoTaskHandle> {
    const apiKey = await this.resolveKey()
    const model = input.model ?? this.resolveModel()
    const payload: Record<string, unknown> = {
      model,
      content: buildContent(input),
    }
    // Ark names the aspect ratio `ratio` and takes 'adaptive' for the modes
    // that derive it from the input; the seam's `size` carries exactly that set.
    if (input.size !== undefined) payload['ratio'] = input.size
    if (input.duration !== undefined) payload['duration'] = input.duration
    if (input.resolution !== undefined) payload['resolution'] = input.resolution
    if (input.generateAudio !== undefined) payload['generate_audio'] = input.generateAudio
    if (input.returnLastFrame !== undefined) payload['return_last_frame'] = input.returnLastFrame
    if (input.outputFormat !== undefined) payload['output_format'] = input.outputFormat
    if (input.callbackUrl !== undefined) payload['callback_url'] = input.callbackUrl
    if (input.watermark !== undefined) payload['watermark'] = input.watermark
    if (input.seed !== undefined) payload['seed'] = input.seed
    const taskType = arkTaskType(input.generationType)
    if (taskType !== undefined) payload['omni_reference_task_type'] = taskType

    let response: { status: number, data: unknown }
    try {
      response = await postJson(
        `${this.resolveBaseUrl()}/contents/generations/tasks`,
        apiKey,
        payload,
        signal,
      )
    } catch (error) {
      // A transport failure at submission means the task was never accepted, so
      // re-submitting cannot double-bill — but the stage must be named.
      throw isNetworkError(error)
        ? new ArkNetworkError(`Ark video submission ${error.message}`, error)
        : error
    }
    const { status, data } = response
    if (status !== 200) {
      throw new ArkHttpError(await this.submitFailureMessage(status, data, signal), status)
    }
    const submit = data as ArkSubmitResponse
    const taskId = submit.id
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new ArkHttpError('Ark video submission returned no task id', 200)
    }
    // The handle pins the endpoint resolved at submit time: a task id belongs to
    // the endpoint that accepted it, so a later Settings change must not
    // redirect an in-flight poll to a different host.
    return new ArkTaskHandle(taskId, model, this.resolveBaseUrl(), () => this.resolveKey())
  }

  /**
   * Compose the failure message for a refused submission. Ark's own
   * `error.message` is always included — it is the only authoritative reason —
   * and a refusal naming a model id or endpoint Ark no longer serves is followed
   * by the ids it does serve. Without that list the refusal reads as "the task
   * does not exist", which sends a caller looking for a task that was never
   * created instead of at the model id it configured.
   * @param status - the HTTP status Ark answered.
   * @param data - the parsed error body.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the one-line message, a failed model lookup included as a hint.
   */
  private async submitFailureMessage(status: number, data: unknown, signal?: AbortSignal): Promise<string> {
    const detail = arkErrorDetail(data)
    const code = detail.code === undefined ? '' : `（${detail.code}）`
    // A 404 on THIS path never means "no such task" — the task was refused
    // before it existed. Ark's own words are the diagnosis, and the ids it does
    // serve are the way out; the generic status wording is deliberately skipped.
    if (isModelNotFound(status, detail)) {
      const reason = detail.message ?? '模型或接入点不存在（方舟未说明原因）'
      const available = await this.availableModelHint(signal)
      return `Ark video submission failed [${status}]${code} ${reason}；${available}`
    }
    const reason = detail.message === undefined
      ? arkStatusMeaning(status)
      : `${arkStatusMeaning(status)}：${detail.message}`
    return `Ark video submission failed [${status}]${code} ${reason}`
  }

  /**
   * The available-model hint appended to a model-not-found failure. Every
   * failure on this path is swallowed: the model list is a courtesy, and a
   * lookup that fails must never replace the real refusal.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns a `可用模型：…` line, or why the list could not be read.
   */
  private async availableModelHint(signal?: AbortSignal): Promise<string> {
    try {
      const models = await this.listModels(signal)
      const ids = formatModelIds(models)
      return ids === '' ? '可用模型：方舟未返回任何视频模型' : `可用模型：${ids}`
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `可用模型列表获取失败：${reason}`
    }
  }

  async finalize(
    handle: VideoTaskHandle,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<VideoGenerationResult> {
    const poll = await handle.poll(signal)
    const url = poll.resultUrl
    if (url === undefined) {
      throw new ArkHttpError(`Ark task ${handle.taskId} has no result URL to probe`)
    }
    onProgress?.({ phase: 'downloading', percent: 0 })
    // Bound the probe so a hung CDN cannot block finalize forever.
    let probe: Awaited<ReturnType<typeof probeResult>>
    try {
      probe = await probeResult(url, signal !== undefined
        ? AbortSignal.any([signal, AbortSignal.timeout(VIDEO_PROBE_TIMEOUT_MS)])
        : AbortSignal.timeout(VIDEO_PROBE_TIMEOUT_MS))
    } catch (error) {
      // The generation already succeeded at this point; only the result fetch
      // failed, so a retry costs nothing.
      throw isNetworkError(error)
        ? new ArkNetworkError(`Ark task ${handle.taskId} result probe ${error.message}`, error)
        : error
    }
    if (probe === undefined || probe.status < 200 || probe.status >= 300) {
      throw new ArkHttpError(
        `Ark task ${handle.taskId} result URL is unreachable [${probe?.status ?? 'no-body'}]`,
        probe?.status,
      )
    }
    onProgress?.({ phase: 'saving', percent: 100 })
    const mediaRef: MediaRef = {
      url,
      mediaType: 'video/mp4',
      ...(probe.sizeBytes === undefined ? {} : { sizeBytes: probe.sizeBytes }),
      expiresAt: Date.now() + MEDIA_URL_TTL_MS,
    }
    return {
      kind: 'video',
      mediaType: 'video/mp4',
      mediaRef,
      providerMeta: {
        provider: this.provider,
        model: handle instanceof ArkTaskHandle ? handle.model : this.defaultModel,
        taskId: handle.taskId,
      },
    }
  }

  /**
   * Probe the endpoint and key the configuration form holds. A read-only task
   * lookup: an id that cannot exist answers 404, which proves the key
   * authenticated and the service answered without creating a task.
   *
   * A row with no key anywhere is reported as `unconfigured`, not as a failure:
   * nothing was probed, and painting that red would hide the difference between
   * "fill this in" and "what you filled in is wrong".
   */
  async probe(draft: ProviderProbeDraft): Promise<ProviderProbeResult> {
    const base = draft.baseUrl.trim() === ''
      ? this.resolveBaseUrl()
      : draft.baseUrl.trim().replace(/\/+$/, '')
    if (base === '') return { status: 'failed', message: '表单未填写接口地址，且该后端也未配置默认端点' }
    const apiKey = await this.probeKey(draft.apiKey)
    if (apiKey === undefined) {
      return { status: 'unconfigured', message: arkUnconfiguredReason(this.apiKeyEnv) }
    }
    try {
      const { status } = await getJson(`${base}/contents/generations/tasks/connection-probe`, apiKey)
      if (status < 500 && status !== 401 && status !== 403) {
        return { status: 'ok', message: `连接成功（HTTP ${status}）` }
      }
      return {
        status: 'failed',
        message: status === 401 || status === 403
          ? `API Key 被拒绝（HTTP ${status}）`
          : `端点返回 HTTP ${status}`,
      }
    } catch (error) {
      return { status: 'failed', message: `无法连接端点：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const apiKey = await this.resolveKey()
      // A read-only probe: GET an id that cannot exist. 404 proves the key
      // authenticated and the service answered, without creating a task — and
      // therefore without spending a generation.
      const { status } = await getJson(
        `${this.resolveBaseUrl()}/contents/generations/tasks/connection-probe`,
        apiKey,
      )
      return status < 500 && status !== 401 && status !== 403
    } catch {
      return false
    }
  }
}
