/**
 * MaiziAI image provider — v2 synchronous (OpenAI-compatible) with a 202 →
 * poll fallback, rewritten in TypeScript from autovideo's
 * `MaiziImageClient`. The provider holds no API key: every operation resolves
 * `MAIZI_API_KEY` through `ctx.credentials` and lands the image bytes through
 * `ctx.attachments.saveImage`, so base64 never leaks into the canonical value
 * or the model context.
 *
 * @module @roubaai/media-maizi/maizi-image-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ImageProvider, readActiveMediaProvider } from '@roubaai/media'
import type { ImageGenerationResult, ImageGenerateInput, MediaProgress } from '@roubaai/media'
import { getJson, postJson, downloadBytes, MaiziHttpError } from './http.ts'
import { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'

/**
 * Default Maizi image base URL (v1 asynchronous). We submit image generation
 * through the v1 async endpoint (returns a `task_id` immediately) and poll
 * `GET /v1/tasks/{id}` to completion — the v2 synchronous endpoint instead
 * blocks the HTTP response until the server has generated the image (which can
 * take minutes), which a background job should not wait on.
 */
export const MAIZI_IMAGE_BASE_URL = 'https://www.maizitech.xyz/v1'

/** Credential reference for the Maizi API key. */
export const MAIZI_API_KEY_REF = 'MAIZI_API_KEY'

/** Default image model (GPT Image 2, best quality/cost balance; supports 1K/2K/4K). */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'

/** Foreground poll ceiling for the 202 → poll path (default 6min, matching autovideo's Maizi client which waits 360s for image tasks). */
export const DEFAULT_IMAGE_POLL_TIMEOUT_MS = 360_000

/** Poll interval for the 202 → poll path (Maizi docs suggest 5-10s). */
const IMAGE_POLL_INTERVAL_MS = 5_000

/** Max reference images (Maizi hard cap). */
const MAX_REF_IMAGES = 9

/** Upper bound on a downloaded image result (Maizi results are a few MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * Sniff the image media type from its magic bytes, defaulting to PNG for an
 * unrecognized payload. Used instead of hard-coding `image/png` so a JPEG/GIF/
 * WebP result is persisted with its real type.
 */
function sniffImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF is normalized to PNG (the result mediaType contract has no gif).
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/png'
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return 'image/webp'
  }
  return 'image/png'
}

/** Raised when the 202 poll exceeds the foreground timeout; carries `taskId`. */
export class ImagePollTimeoutError extends Error {
  readonly code = 'IMAGE_POLL_TIMEOUT'
  readonly taskId: string
  constructor(taskId: string) {
    super(`image generation timed out before completion (task ${taskId}); retry or poll the task later`)
    this.name = 'ImagePollTimeoutError'
    this.taskId = taskId
  }
}

/** Raised when the credential resolve returns `undefined` (distinct from NO_PROVIDER). */
export class MissingCredentialError extends Error {
  readonly code = 'MISSING_CREDENTIAL'
  constructor(ref: string) {
    super(`no API key resolved for "${ref}"; store it through the credentials service or export it in the environment`)
    this.name = 'MissingCredentialError'
  }
}

/** Provider config; every field is optional with a sensible default. */
export interface MaiziImageConfig {
  /** Endpoint base; defaults to the public v2 API. */
  baseUrl?: string
  /** Default model id; defaults to {@link DEFAULT_IMAGE_MODEL}. */
  model?: string
  /** Credential reference (environment-variable name); defaults to `MAIZI_API_KEY`. */
  apiKeyEnv?: string
  /** Foreground poll ceiling for the 202 → poll path in ms; defaults to 60s. */
  pollTimeoutMs?: number
  /**
   * Settings namespace the roubaai video plugin's Settings page owns. The
   * stored key and endpoint win over {@link MaiziImageConfig.baseUrl} and the
   * credential reference; they are read per operation, so editing the Settings
   * page takes effect without reloading this plugin.
   * Defaults to {@link DEFAULT_SETTINGS_NAMESPACE}.
   */
  settingsNamespace?: string
}

/** One resolved Maizi task payload from `GET /v2/tasks/{id}`. */
interface MaiziTask {
  status?: string
  result_urls?: string[]
  error_msg?: string
  data?: Array<{ b64_json?: string; url?: string }>
}

/** One resolved Maizi image-generation response item. */
interface MaiziImageItem {
  /** Async submission nests the task id here. */
  task_id?: string
  b64_json?: string
  url?: string
  error?: string
}

/** A `data`-wrapped Maizi image response (200 or a polled completed task). */
interface MaiziImageResponse {
  data?: MaiziImageItem[]
  task_id?: string
  id?: string
}

/**
 * Decode a base64 payload into bytes. Accepts a bare base64 string or a
 * `data:image/...;base64,...` data URI.
 */
function decodeBase64(payload: string): Uint8Array {
  const comma = payload.indexOf(',')
  const raw = comma >= 0 && payload.startsWith('data:') ? payload.slice(comma + 1) : payload
  return new Uint8Array(Buffer.from(raw, 'base64'))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, ms)
      return
    }
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Maizi image provider (v2 sync + 202 poll fallback). Lands images through
 * `ctx.attachments.saveImage`; never returns raw base64.
 */
export class MaiziImageProvider extends ImageProvider {
  readonly provider = 'maizi'
  readonly defaultModel: string

  private readonly baseUrl: string
  private readonly apiKeyEnv: string
  private readonly pollTimeoutMs: number
  private readonly settingsNamespace: string

  constructor(private readonly ctx: Context, config: MaiziImageConfig = {}) {
    super()
    this.baseUrl = config.baseUrl ?? MAIZI_IMAGE_BASE_URL
    this.defaultModel = config.model ?? DEFAULT_IMAGE_MODEL
    this.apiKeyEnv = config.apiKeyEnv ?? MAIZI_API_KEY_REF
    this.pollTimeoutMs = config.pollTimeoutMs ?? DEFAULT_IMAGE_POLL_TIMEOUT_MS
    this.settingsNamespace = config.settingsNamespace ?? DEFAULT_SETTINGS_NAMESPACE
  }

  /**
   * Resolve the API key per operation. The Settings page's active provider
   * wins over the credential store: it is the deployment's explicit
   * per-install choice, and the one surface a person can edit without touching
   * the environment. The credential store — and through it `MAIZI_API_KEY` —
   * stays the fallback, so a deployment that never opens the Settings page is
   * unaffected.
   * @throws {MissingCredentialError} when neither source holds a key.
   */
  private async resolveKey(): Promise<string> {
    const configured = readActiveMediaProvider(this.ctx, this.settingsNamespace, 'image').apiKey
    if (configured !== undefined) return configured
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(this.apiKeyEnv))
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    throw new MissingCredentialError(this.apiKeyEnv)
  }

  /**
   * Endpoint base: the Settings page's active-provider override when one is
   * stored, else the deployment-configured base. A trailing slash is trimmed
   * so a pasted URL cannot produce a `//` path segment.
   */
  private resolveBaseUrl(): string {
    const override = readActiveMediaProvider(this.ctx, this.settingsNamespace, 'image').baseUrl
    return (override ?? this.baseUrl).replace(/\/+$/, '')
  }

  /**
   * Default image model: the Settings page's active-provider override when one
   * is stored, else the deployment-configured model. `ImageGenerateInput`
   * carries no model field, so this value is the only thing that decides which
   * model runs — which is exactly why it has to be re-read per operation.
   */
  private resolveModel(): string {
    return readActiveMediaProvider(this.ctx, this.settingsNamespace, 'image').model ?? this.defaultModel
  }

  async generate(
    input: ImageGenerateInput,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<ImageGenerationResult> {
    const apiKey = await this.resolveKey()
    // Resolved once per generation so the request, the landed attachment name,
    // and the reported `providerMeta` can never disagree about the model.
    const model = this.resolveModel()
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      response_format: 'b64_json',
      n: 1,
    }
    if (input.refImages !== undefined && input.refImages.length > 0) {
      payload['images'] = input.refImages.slice(0, MAX_REF_IMAGES)
    }
    if (input.width !== undefined && input.height !== undefined) {
      payload['size'] = `${input.width}x${input.height}`
    } else if (input.aspectRatio !== undefined) {
      payload['size'] = input.aspectRatio
    } else {
      payload['size'] = '1:1'
    }
    payload['image_size'] = input.resolution ?? '1K'
    payload['quality'] = input.quality ?? 'low'

    // Submit through the v1 async endpoint: it returns a `task_id` immediately
    // (fast), then we poll `GET /v1/tasks/{id}` to completion. The v2
    // synchronous endpoint would instead block the HTTP response until the
    // server has generated the image (which can take minutes), which a
    // background job must not wait on.
    const { status, data } = await postJson(
      `${this.resolveBaseUrl()}/images/generations`,
      apiKey,
      payload,
      signal,
    )
    if (status !== 200 && status !== 202) {
      throw new MaiziHttpError(`Maizi image generation failed [${status}]`, status)
    }
    const response = data as MaiziImageResponse
    // v1 async nests the task id under `data[0].task_id`; some responses also
    // surface it at the top level, so accept either shape.
    const taskId = response.data?.[0]?.task_id ?? response.task_id ?? response.id
    if (taskId === undefined) {
      throw new MaiziHttpError('Maizi returned no task id for image generation', status)
    }
    const { url, bytes } = await this.pollTask(taskId, apiKey, signal, onProgress)
    // The image exists server-side (a result URL was returned). Degrade to a
    // URL reference when we cannot land the bytes locally — never fail the job
    // or force a regenerate: "has a URL" already means the image exists.
    if (bytes === undefined) {
      if (url === undefined) {
        throw new MaiziHttpError(`Maizi task ${taskId} completed with no result`, 200)
      }
      return this.urlRef(url, model)
    }
    try {
      return await this.land(bytes, model, url)
    } catch {
      if (url === undefined) throw new MaiziHttpError(`Maizi task ${taskId} result could not be saved`, 200)
      return this.urlRef(url, model)
    }
  }

  /**
   * Degrade a generated-but-not-landed image to a URL-only reference. The
   * model is passed in (not re-resolved) so the reported `providerMeta` names
   * the model this generation actually used.
   */
  private urlRef(url: string, model: string): ImageGenerationResult {
    return {
      kind: 'image',
      mediaType: 'image/png',
      mediaRef: {
        url,
        mediaType: 'image/png',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      },
      providerMeta: { provider: this.provider, model: model },
    }
  }

  /**
   * Poll a 202-submitted task until `completed`/`failed`/`violation`, under the
   * foreground timeout ceiling. On timeout, throws {@link ImagePollTimeoutError}
   * carrying the task id (so the model may retry or query later), rather than
   * blocking the foreground indefinitely.
   */
  private async pollTask(
    taskId: string,
    apiKey: string,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<{ url?: string; bytes?: Uint8Array }> {
    const deadline = Date.now() + this.pollTimeoutMs
    for (;;) {
      if (Date.now() >= deadline) {
        throw new ImagePollTimeoutError(taskId)
      }
      await sleep(IMAGE_POLL_INTERVAL_MS, signal)
      const { status, data } = await getJson(
        `${this.resolveBaseUrl()}/tasks/${taskId}`,
        apiKey,
        signal,
      )
      if (status !== 200) continue
      const task = data as MaiziTask
      const taskStatus = task.status
      if (taskStatus === 'completed') {
        const urls = task.result_urls ?? []
        const firstUrl = urls[0]
        if (firstUrl !== undefined) {
          try {
            const bytes = await this.downloadResult(firstUrl, signal, onProgress)
            return { url: firstUrl, bytes }
          } catch {
            // The image exists server-side; degrade to a URL-only ref rather
            // than failing the task (the caller must not regenerate).
            return { url: firstUrl }
          }
        }
        // A completed task may embed its data inline.
        const inline = (task as unknown as MaiziImageResponse).data?.[0]
        if (inline?.b64_json !== undefined) return { bytes: decodeBase64(inline.b64_json) }
        if (inline?.url !== undefined) {
          try {
            const bytes = await this.downloadResult(inline.url, signal, onProgress)
            return { url: inline.url, bytes }
          } catch {
            return { url: inline.url }
          }
        }
        throw new MaiziHttpError(`Maizi task ${taskId} completed with no result`, 200)
      }
      if (taskStatus === 'failed' || taskStatus === 'violation') {
        throw new MaiziHttpError(`Maizi task ${taskId} ${taskStatus}: ${task.error_msg ?? 'no error message'}`)
      }
    }
  }

  /** Download a completed result URL, reporting download progress. */
  private async downloadResult(
    url: string,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<Uint8Array> {
    onProgress?.({ phase: 'downloading', percent: 0 })
    const bytes = await downloadBytes(url, signal, {
      // Cap the result so a huge or malicious CDN payload cannot be buffered
      // in full; Maizi image results are at most a few MB.
      maxBytes: MAX_IMAGE_BYTES,
      onProgress: (received, total) => {
        onProgress?.({
          phase: 'downloading',
          percent: total !== undefined && total > 0 ? Math.round((received / total) * 100) : 0,
        })
      },
    })
    onProgress?.({ phase: 'saving', percent: 100 })
    return bytes
  }

  /** Persist image bytes and return the unified result reference. */
  private async land(bytes: Uint8Array, model: string, resultUrl?: string): Promise<ImageGenerationResult> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('media-maizi: ctx.attachments is missing; cannot persist the generated image')
    }
    const mediaType = sniffImageMediaType(bytes)
    const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
    const ref = await attachments.saveImage({
      data: bytes,
      mediaType,
      name: `generated.${extension}`,
    })
    return {
      kind: 'image',
      attachmentRef: ref.attachmentId,
      attachment: ref,
      // Use the sniffed type (no gif) rather than the attachment's mediaType,
      // which `saveImage` may widen to include `image/gif`.
      mediaType,
      // Keep the provider's 24h result URL on the landed path too: the
      // completion message surfaces it so `media_asset_save` can fetch it as
      // a fallback when the attachment reference cannot be resolved.
      ...resultUrl !== undefined ? { resultUrl } : {},
      providerMeta: {
        provider: this.provider,
        model,
      },
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const apiKey = await this.resolveKey()
      // A read-only probe: GET an obviously nonexistent task id. This verifies
      // the key (401/403) and service reachability (5xx) without submitting a
      // real, billable generation — the previous probe POSTed `/images/
      // generations` and caused a paid side effect every time it ran.
      const { status } = await getJson(
        `${this.resolveBaseUrl()}/tasks/nonexistent-probe-connection`,
        apiKey,
      )
      // 2xx or 404 both prove the key authenticated and the service is up
      // (404 just means the probe task does not exist). 401/403 mean a bad
      // key; 5xx means the service is down. Anything else is inconclusive.
      return status < 500 && status !== 401 && status !== 403
    } catch {
      return false
    }
  }
}
