/**
 * MxAPI music provider — Suno-style v2 asynchronous generate/task semantics.
 * The provider holds no API key (resolves `MXAPI_API_KEY` per operation) and
 * normalizes MxAPI's state machine (`result.status` 1=queued/2=generating,
 * 3=complete, 4=failed; `data.status` string form) into the provider-agnostic
 * {@link MusicTaskPoll}.
 *
 * One generate call returns **2 task ids** (Suno returns two candidates per
 * request); the tool's polling loop resolves on the first completed one.
 * Provider-specific facts — the `extend` JSON blob, points costing, the
 * `custom_id` reuse contract — stay inside this implementation. The completed
 * mp3 URL is NOT downloaded here (music is small, but the tool result's URL
 * feeds `media_asset_save`, which persists bytes itself).
 *
 * @module @roubaai/media-mxapi/mxapi-music-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { MusicProvider, readActiveMediaProvider } from '@roubaai/media'
import type {
  MusicGenerateInput, MusicTaskHandle, MusicTaskPoll, MusicTrackInfo, ProviderProbeDraft, ProviderProbeResult,
} from '@roubaai/media'
import { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'

/** Default MxAPI music base URL (Suno v2 async). */
export const MXAPI_MUSIC_BASE_URL = 'https://open.mxapi.org/api/v2/music'

/** Credential reference for the MxAPI key. */
export const MXAPI_API_KEY_REF = 'MXAPI_API_KEY'

/** Default Suno model version (v4.5+, the doc-recommended balance). */
export const DEFAULT_MUSIC_MODEL = 'chirp-bluejay'

/** Raised on non-2xx or non-`code:200` responses, and on a missing credential. */
export class MxapiApiError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'MxapiApiError'
    this.status = status
  }
}

export class MissingCredentialError extends Error {
  readonly envVar: string
  constructor(envVar: string) {
    super(`MxAPI credential "${envVar}" is not configured`)
    this.name = 'MissingCredentialError'
    this.envVar = envVar
  }
}

/** Envelope shared by every MxAPI v2 response. */
interface MxapiEnvelope<T> {
  code?: number
  message?: string
  data?: T
}

/** Generate response payload. */
interface MxapiGenerateData {
  task_ids?: string[] | null
}

/** One music task payload from `GET /music/task?id=`. */
interface MxapiMusicTask {
  id?: number
  task_id?: string
  status?: string
  result?: {
    status?: number
    custom_id?: string
    progress?: number
    error?: string | null
    fileInfo?: {
      duration?: number
      mp3Url?: string
      mp4Url?: string
      cosUrl?: string
    } | null
    extend?: string | null
  } | null
  error?: string | null
}

/** Provider configuration. */
export interface MxapiMusicConfig {
  /** Endpoint base override (defaults to {@link MXAPI_MUSIC_BASE_URL}). */
  baseUrl?: string
  /** Default Suno model version (mv). */
  model?: string
  /** Credential reference (environment-variable name); defaults to `MXAPI_API_KEY`. */
  apiKeyEnv?: string
}

/**
 * MxAPI music provider (Suno v2 submit/poll). Resolve the API key per
 * operation through `ctx.credentials`; never persist it.
 */
export class MxapiMusicProvider extends MusicProvider {
  readonly provider = 'mxapi'
  readonly defaultModel: string

  private readonly ctx: Context
  private readonly baseUrl: string
  private readonly apiKeyEnv: string

  constructor(ctx: Context, config: MxapiMusicConfig = {}) {
    super()
    this.ctx = ctx
    this.baseUrl = (config.baseUrl ?? MXAPI_MUSIC_BASE_URL).replace(/\/$/, '')
    this.defaultModel = config.model ?? DEFAULT_MUSIC_MODEL
    this.apiKeyEnv = config.apiKeyEnv ?? MXAPI_API_KEY_REF
  }

  /**
   * Resolve the API key for one operation: the Settings page's active music
   * provider wins, then the credential store (`MXAPI_API_KEY`) — the same
   * order the Maizi providers use (settings first, then credentials/env).
   */
  private async resolveKey(): Promise<string> {
    const stored = readActiveMediaProvider(this.ctx, DEFAULT_SETTINGS_NAMESPACE, 'music').apiKey
    if (stored !== undefined) return stored
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new MissingCredentialError(this.apiKeyEnv)
    }
    const hit = await credentials.resolve(credentialRef(this.apiKeyEnv))
    if (hit === undefined || hit.value === undefined || hit.value === '') {
      throw new MissingCredentialError(this.apiKeyEnv)
    }
    return hit.value
  }

  private async request<T>(path: string, init: RequestInit | undefined, signal?: AbortSignal): Promise<T> {
    const apiKey = await this.resolveKey()
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...init?.headers as Record<string, string> | undefined,
      },
      // exactOptionalPropertyTypes: an explicit `signal: undefined` is not
      // assignable to RequestInit's `signal?: AbortSignal | null` slot.
      ...(signal !== undefined ? { signal } : {}),
    } as RequestInit)
    if (!response.ok) {
      throw new MxapiApiError(`MxAPI ${path} failed (HTTP ${response.status})`, response.status)
    }
    const body = await response.json() as MxapiEnvelope<T>
    if (body.code !== 200 || body.data === undefined) {
      throw new MxapiApiError(`MxAPI ${path} rejected: ${body.message ?? `code ${body.code ?? 'unknown'}`}`)
    }
    return body.data
  }

  async submit(input: MusicGenerateInput, signal?: AbortSignal): Promise<MusicTaskHandle[]> {
    // Mode mapping: description → 灵感模式 (gpt_description_prompt);
    // lyrics (+tags) → 自定义模式 (prompt + tags).
    // Model resolution order: the call's explicit model, then the Settings
    // page's active music provider, then the provider default (read per
    // operation, so a Settings-page edit applies without reloading this
    // provider).
    const payload: Record<string, unknown> = {
      mv: input.model ?? readActiveMediaProvider(this.ctx, DEFAULT_SETTINGS_NAMESPACE, 'music').model ?? this.defaultModel,
    }
    if (input.description !== undefined && input.description.trim().length > 0) {
      payload['gpt_description_prompt'] = input.description
    } else {
      payload['prompt'] = input.lyrics
      if (input.tags !== undefined) payload['tags'] = input.tags
    }
    if (input.negativeTags !== undefined) payload['negative_tags'] = input.negativeTags
    if (input.title !== undefined) payload['title'] = input.title
    if (input.instrumental !== undefined) payload['make_instrumental'] = input.instrumental
    const metadata: Record<string, unknown> = {}
    if (input.vocalGender !== undefined) metadata['vocal_gender'] = input.vocalGender
    const sliders: Record<string, number> = {}
    if (input.styleWeight !== undefined) sliders['style_weight'] = input.styleWeight
    if (input.weirdnessConstraint !== undefined) sliders['weirdness_constraint'] = input.weirdnessConstraint
    if (Object.keys(sliders).length > 0) metadata['control_sliders'] = sliders
    if (Object.keys(metadata).length > 0) payload['metadata'] = metadata

    const data = await this.request<MxapiGenerateData>('/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, signal)
    const taskIds = data.task_ids ?? []
    if (taskIds.length === 0) {
      throw new MxapiApiError('MxAPI generate returned no task ids')
    }
    return taskIds.map(taskId => ({
      taskId,
      poll: (pollSignal?: AbortSignal) => this.pollTask(taskId, pollSignal ?? signal),
    }))
  }

  /** Poll one task, normalizing MxAPI's dual status fields. */
  async pollTask(taskId: string, signal?: AbortSignal): Promise<MusicTaskPoll> {
    const task = await this.request<MxapiMusicTask>(`/task?id=${encodeURIComponent(taskId)}`, {
      method: 'GET',
    }, signal)
    // `result.status`: 1=queued 2=generating 3=complete 4=failed. The string
    // `status` covers pre-result states (pending/running/completed/failed).
    const supplierStatus = task.result?.status
    if (supplierStatus === 3 || task.status === 'completed') {
      return { status: 'succeeded', progress: 100 }
    }
    if (supplierStatus === 4 || task.status === 'failed') {
      return { status: 'failed', errorMsg: task.result?.error ?? task.error ?? 'music generation failed' }
    }
    return {
      status: 'running',
      ...task.result?.progress !== undefined ? { progress: task.result.progress } : {},
    }
  }

  /** Fetch the terminal track info for a task that polled `succeeded`. */
  async fetchTrack(taskId: string, signal?: AbortSignal): Promise<MusicTrackInfo> {
    const task = await this.request<MxapiMusicTask>(`/task?id=${encodeURIComponent(taskId)}`, {
      method: 'GET',
    }, signal)
    const info = task.result?.fileInfo
    const audioUrl = info?.mp3Url
    if (audioUrl === undefined || audioUrl === '') {
      throw new MxapiApiError(`MxAPI task ${taskId} completed without an mp3 URL`)
    }
    return {
      audioUrl,
      ...task.result?.custom_id !== undefined ? { clipId: task.result.custom_id } : {},
      ...info?.duration !== undefined ? { durationSeconds: info.duration } : {},
      ...info?.cosUrl !== undefined && info.cosUrl !== '' ? { coverUrl: info.cosUrl } : {},
    }
  }

  /**
   * Probe the endpoint and key a configuration form holds. The music API is not
   * OpenAI-compatible and has no `GET /models`, so the cheapest authenticated
   * request is a task lookup: an unknown id answers a business-JSON 404, which
   * still proves the endpoint is reachable and the key accepted (an
   * unauthorized key is refused before the id is read).
   */
  async probe(draft: ProviderProbeDraft): Promise<ProviderProbeResult> {
    if (draft.apiKey.trim() === '') return { ok: false, message: '未填写 API Key' }
    const base = draft.baseUrl.trim().replace(/\/+$/, '')
    if (base === '') return { ok: false, message: '未填写接口地址' }
    try {
      const response = await fetch(`${base}/task?id=connection-probe`, {
        method: 'GET',
        headers: { authorization: `Bearer ${draft.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (response.ok) return { ok: true, message: `连接成功（HTTP ${response.status}）` }
      if (response.status === 404) {
        const body = await response.json().catch(() => undefined) as { code?: unknown, message?: unknown } | undefined
        if (typeof body === 'object' && body !== null && body['code'] !== undefined) {
          return { ok: true, message: `连接成功（HTTP 404，${String(body['message'] ?? '任务不存在')}）` }
        }
      }
      return {
        ok: false,
        message: response.status === 401 || response.status === 403
          ? `API Key 被拒绝（HTTP ${response.status}）`
          : `端点返回 HTTP ${response.status}`,
      }
    } catch (error) {
      return { ok: false, message: `无法连接端点：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Connectivity test: resolves the key, then issues a cheap task probe. */
  async testConnection(): Promise<boolean> {
    try {
      // A missing id is a free 4xx from the API — but it still proves the key
      // authenticated (401 would fail first) and the service is reachable.
      await this.request<MxapiMusicTask>('/task?id=connection-probe', { method: 'GET' })
      return true
    } catch (error) {
      if (error instanceof MissingCredentialError) return false
      // A rejection mentioning a non-auth failure still proves reachability.
      return !(error instanceof MxapiApiError && error.status === 401)
    }
  }
}

export default MxapiMusicProvider
