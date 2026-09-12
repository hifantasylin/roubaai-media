/**
 * Media generation provider seam: the provider-neutral abstract classes a
 * media provider implements. Mirrors autovideo's `base.py`
 * `BaseImageGenerator`/`BaseVideoGenerator` in TypeScript, but keeps only the
 * cross-provider minimal public contract — provider-specific fields (Maizi's
 * `violation`, `queued`, `costUsd`, multi-URL structure, 24h download policy)
 * live in the provider implementation layer, never here.
 *
 * Images return a landed resource reference (never raw base64); video is
 * asynchronous, so it is split into `submit` + `finalize` over a pollable
 * handle.
 *
 * @module @roubaai/media/provider
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Mid-flight progress callback a media tool can pass into a provider so a
 * long-running generation/download can surface real progress to the job list.
 * `phase` distinguishes the generation stage from the result download;
 * `percent` is a best-effort 0-100 figure (0 when the stage has no discrete
 * numerator, e.g. generation without a provider progress field).
 */
export interface MediaProgress {
  /** Stage label: 'generating' | 'downloading' | 'saving'. */
  phase: 'generating' | 'downloading' | 'saving'
  /** Completion percent within the current phase, 0-100. */
  percent: number
}

/**
 * A unified media reference produced by a provider for inline display + on
 * demand download: the 24h-valid result URL plus its type, size (when known)
 * and a hardcoded expiry timestamp. `expiresAt` is a conservative
 * `generation-complete + 24h` — Maizi returns no precise expiry field, so the
 * 24h policy is fixed here and surfaced to the frontend as a hint.
 */
export interface MediaRef {
  /** The 24h-valid result URL (never surfaced bare; proxied via the host). */
  url: string
  /** MIME type of the referenced media. */
  mediaType: string
  /** Total byte size when the provider reported one (from `content-length`). */
  sizeBytes?: number
  /** Epoch-ms timestamp when this URL expires (generation-complete + 24h). */
  expiresAt: number
  /**
   * Same-origin signed local stream URL, present once the generation tool has
   * cached the bytes on disk. The player prefers this (fast, offline of the
   * provider) over `url`, which remains as the CDN fallback.
   */
  localUrl?: string
}

/** Image generation result: a landed resource reference, never raw base64. */
export interface ImageGenerationResult {
  kind: 'image'
  /** Landed local/attachment reference (downloaded and persisted within 24h); absent in the degraded URL fallback. */
  attachmentRef?: string
  /** Full landed attachment reference (id + dimensions + bytes) for inline image rendering; absent in the degraded URL fallback. */
  attachment?: ImageAttachmentRef
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  /**
   * Fallback URL reference when the image was generated (server-side) but
   * could not be landed locally (download/save failed). Presence here signals
   * "the image exists — do not regenerate"; consumers should surface the URL
   * rather than re-invoke the tool.
   */
  mediaRef?: MediaRef
  /**
   * Provider's original 24h-valid result URL, present on the normal landed
   * path too (not just the degraded `mediaRef` fallback). Surfaced in the
   * completion message so the model can pass it to `media_asset_save` as a
   * fetchable https fallback — the attachment library stays the primary
   * reference; this URL dies after provider expiry.
   */
  resultUrl?: string
  /**
   * What the run actually did — model, tier, and the vendor-reported pixel
   * size — when the provider can state it. Optional so a provider that has not
   * been taught to report it keeps working unchanged; the tool synthesizes a
   * minimal echo from `providerMeta` for those.
   */
  run?: ImageRunInfo
  /** Provider raw return (URL / taskId), for logs and replay. */
  providerMeta: { provider: string; model: string; costUsd?: number }
}

export interface ImageGenerateInput {
  prompt: string
  /**
   * Explicit model override. Absent means "the model this provider is
   * configured to use" (the Settings page's active row, else its own default),
   * which is the ordinary case — and the only case the tools produce: a tier the
   * configured model cannot serve is refused, never moved onto another model. A
   * provider that cannot honour an override ignores it and names the model it
   * actually used in `providerMeta.model`.
   */
  model?: string
  /** Reference image URLs to guide/edit the generation (max 9; the provider truncates). */
  refImages?: string[]
  width?: number
  height?: number
  /** Aspect ratio like '1:1' | '16:9'; mutually exclusive with width/height. */
  aspectRatio?: string
  /** Resolution tier (e.g. '1K' | '1.5K' | '2K' | '3K' | '4K'); the accepted set is per model. */
  resolution?: string
  /** Quality 'low' | 'medium' | 'high'. */
  quality?: string
  /** Provider-specific parameter passthrough. */
  extra?: Record<string, unknown>
}

/**
 * Values a configuration form is looking at, an unsaved key included. A probe
 * runs against these rather than the stored document so a key can be verified
 * in the same breath it is typed.
 */
export interface ProviderProbeDraft {
  /** Endpoint base the form shows. */
  baseUrl: string
  /** API key the form holds. */
  apiKey: string
  /** Model the form shows, when the category configures one. */
  model?: string
}

/**
 * Outcome of a connectivity probe, as one of three states.
 *
 * The distinction matters because "nobody has configured this backend yet" and
 * "this backend was configured and refused" are different situations for the
 * person looking at the page: the first is a neutral to-do, the second is a
 * failure that needs the vendor's own reason. Collapsing both into one boolean
 * paints an empty row red, which teaches the reader to ignore red.
 */
export interface ProviderProbeResult {
  /**
   * `ok` — the endpoint answered and accepted the key.
   * `unconfigured` — no key exists anywhere (form draft, stored settings, or
   * the provider's own environment fallback), so nothing was probed.
   * `failed` — a key exists and the probe did not succeed.
   */
  status: 'ok' | 'unconfigured' | 'failed'
  /**
   * Human-readable outcome. For `unconfigured` this is the reason fragment the
   * caller prefixes with its own "no key configured" label (e.g. "form empty,
   * nothing stored, ARK_API_KEY unset"); for `failed` it carries the HTTP
   * status and the backend's own error message.
   */
  message: string
}

/**
 * One model a backend currently offers, as the vendor reports it. Returned by
 * the optional {@link ImageProvider.listModels} /
 * {@link VideoProvider.listModels} capability.
 *
 * Vendor model ids are NOT a stable contract: they embed a release or date
 * segment (`doubao-seedream-5-0-pro-260628`, `doubao-seedance-2-0-260128`), a
 * vendor renames or re-dates them between releases, and it retires older ids on
 * its own schedule. A caller that hardcodes an id therefore breaks on a date it
 * cannot see; it must ask the backend what exists right now and pick from that
 * answer, treating any locally configured id as a hint rather than a fact.
 */
export interface MediaModelInfo {
  /** The id to send on a request (what the backend answers `GET /models` with). */
  id: string
  /** Display name, when the backend states one; callers fall back to `id`. */
  label?: string
  /** Vendor lifecycle state when reported (e.g. `available`), else omitted. */
  status?: string
  /**
   * Capability tags the backend reports for this id (Ark's `task_type`, e.g.
   * `VideoGeneration` / `ImageGeneration`), verbatim. Absent when the backend
   * reports none — an absent list means "unknown", never "no capability".
   */
  taskTypes?: string[]
}

/**
 * What ONE model of an image backend accepts, as a machine-readable descriptor.
 *
 * It exists because per-model capability is a fact only the backend owns: the
 * resolution tiers a model accepts, the pixel floor below which it refuses a
 * size, how many references it takes, which ratios it serves. Written a second
 * time in a tool schema or a settings page, that fact drifts the moment the
 * vendor ships a model — and the drift shows up as a rejected, billable call.
 * So the provider states it here, and every consumer (the model at tool-call
 * time, the Settings page at configuration time) derives from this one source.
 *
 * Every field but `id` is optional DELIBERATELY: a backend that only knows some
 * of these says only those, and a consumer must read an absent field as
 * "not stated", never as "no such thing". A provider that states nothing at all
 * (see {@link ImageProvider.capabilities}) keeps the seam's original
 * passthrough behavior.
 *
 * A consumer looking for a SIBLING model — one that covers a tier this model
 * does not — finds it through the backend's catalogue (`listModels`), asking
 * this accessor about each id there, rather than from a second static list:
 * vendor ids carry date segments, so a sibling id hardcoded beside this one
 * would go stale exactly like the id it substitutes for.
 */
export interface MediaModelCapability {
  /** The id a request names (the same id the backend's catalogue reports). */
  id: string
  /**
   * Short class label the diagnostic text can use in place of the full id
   * (`lite`, `pro`, `seedance-2.5`). Absent falls back to `id`.
   */
  label?: string
  /**
   * Resolution tiers this model accepts, in the backend's own spelling
   * (`['1K', '1.5K', '2K']`). Absent means "not stated", which consumers must
   * treat as "anything may work" rather than "nothing works".
   */
  tiers?: readonly string[]
  /**
   * Pixel floor: a request whose resolved size is smaller than this is refused
   * by the backend. It is usually also WHY a smaller tier is missing from
   * {@link tiers} (a tier below the floor is physically unservable), which is
   * why the tool's teaching error quotes it.
   */
  minPixels?: number
  /** Most reference images one request may carry. */
  maxRefImages?: number
  /** Aspect ratios this model accepts (`['1:1', '16:9']`); absent means "not stated". */
  aspectRatios?: readonly string[]
  /** Short Chinese hint a person reads on the Settings page (one line). */
  note?: string
}

/**
 * Resolution tier the image tool asks for when the caller names none and the
 * model states its tiers. It is the lowest tier every current Seedream
 * generation shares, so the default is servable on the widest set of models.
 * A provider that states no capability keeps its own default instead — the
 * seam never overrides a backend that has not declared tiers.
 */
export const DEFAULT_IMAGE_RESOLUTION = '2K'

/**
 * What an image run actually did, echoed on the result so the caller can
 * self-correct on its next call: the model it ran on, the tier it asked for,
 * and the pixel size the vendor reported back.
 */
export interface ImageRunInfo {
  /** The model the request ran on. */
  model: string
  /**
   * The resolution tier the request carried (the caller's, the row's, or the
   * default). Absent only when neither the caller nor the provider named one —
   * a backend that declares no capability and was given no tier.
   */
  tier?: string
  /** Pixel size the vendor reported for the produced image (`WxH`), when it reports one. */
  size?: string
}

/**
 * Bounds one provider enforces for an image request. The tool validates against
 * them before submitting, so a request the backend would reject costs nothing.
 */
export interface ImageCaps {
  /** Most reference images one request may carry. */
  maxRefImages: number
}

/**
 * Bounds one provider enforces for a video request. Answered per model: a
 * backend whose newer generation accepts longer clips or more references
 * declares that itself, instead of the shared tool guessing from a model-name
 * pattern that only fits one vendor's naming.
 */
export interface VideoCaps {
  /** Shortest accepted duration in seconds. */
  minDuration: number
  /** Longest accepted duration in seconds. */
  maxDuration: number
  /** Most reference images one request may carry. */
  maxImageUrls: number
  /** Most reference videos one request may carry. */
  maxVideoUrls: number
  /** Most reference audio clips one request may carry. */
  maxAudioUrls: number
}

export abstract class ImageProvider {
  abstract readonly provider: string
  abstract readonly defaultModel: string

  /** Generate an image, returning a landed resource reference. */
  abstract generate(
    input: ImageGenerateInput,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<ImageGenerationResult>

  /** Bounds this provider enforces for the given model (its default when omitted). */
  abstract caps(model?: string): ImageCaps

  /**
   * Estimated USD for one generation at this model and resolution, or
   * `undefined` when this provider cannot price it. Pricing belongs to the
   * provider: the shared tool records what a backend charges, so it owns no
   * rate table of its own.
   * @param model - the model the run used.
   * @param resolution - the resolution tier the run asked for.
   * @returns the estimated USD cost, or `undefined` when unpriceable.
   */
  abstract estimateCostUsd(model: string, resolution: string): number | undefined

  /**
   * Probe this backend with the values a configuration form is looking at,
   * including a key that has not been saved. The adapter owns the probe because
   * only it knows which request proves both reachability and key acceptance for
   * its protocol.
   * @param draft - the values the form shows.
   * @returns whether the endpoint answered favorably, plus the human reason.
   */
  abstract probe(draft: ProviderProbeDraft): Promise<ProviderProbeResult>

  /** Connectivity test (config UI / diagnostics): no args, resolves the key internally. */
  abstract testConnection(): Promise<boolean>
}

/**
 * Optional model-catalogue capability of an image backend, declared as a
 * merged interface rather than an abstract member so a backend that cannot
 * enumerate its models simply does not implement it — the capability is
 * genuinely optional, while an abstract member would make it mandatory for
 * every provider. Callers detect it structurally
 * (`typeof provider.listModels === 'function'`); an implementer declares its
 * members `override` because the merged members still belong to the class.
 */
export interface ImageProvider {
  /**
   * Describe what one of this backend's models accepts, when the backend knows.
   *
   * This is the single source of truth for per-model capability: the tool
   * validates a requested resolution against it BEFORE submitting, so a request
   * the vendor would refuse never reaches a billable endpoint, and the Settings
   * page renders the same facts rather than restating them. A backend that
   * cannot describe its models omits this member entirely and keeps the seam's
   * original passthrough behavior — no validation, no substitution.
   * @param model - the model to describe; omitted describes the model this
   * provider is currently configured to run (its Settings-page row, else its
   * own default).
   * @returns the descriptor, or `undefined` when this backend cannot state one
   * for that id (including an id it does not recognize).
   */
  capabilities?(model?: string): MediaModelCapability | undefined
  /**
   * List the image models this backend offers right now, when it can enumerate
   * them.
   *
   * Vendor ids carry date segments and retire, so this is the only sound way to
   * learn what a deployment may actually request — a caller must not treat its
   * configured id as still valid.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the models the backend reports, or an empty list when it offers none.
   */
  listModels?(signal?: AbortSignal): Promise<MediaModelInfo[]>
  /**
   * List models against the values a configuration form is looking at — an
   * endpoint and an API key that have not been saved yet — when the backend can
   * use them. Companion to {@link ImageProvider.listModels}: a form asks with
   * its draft so a catalogue can be browsed, and a key validated, before
   * anything is stored. A backend that omits this is asked through
   * `listModels`, which reads the stored configuration.
   * @param draft - the endpoint and key the form holds; an empty field means
   * "use the configured value".
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the models the backend reports.
   */
  listModelsWithDraft?(draft: ProviderProbeDraft, signal?: AbortSignal): Promise<MediaModelInfo[]>
}

/** Video generation result: a unified media reference plus the raw task id. */
export interface VideoGenerationResult {
  kind: 'video'
  /** Back-compat landed local/attachment reference; may be absent when the provider streams instead of landing. */
  attachmentRef?: string
  mediaType: 'video/mp4'
  /** Unified media reference for inline streaming + on-demand download. */
  mediaRef: MediaRef
  providerMeta: { provider: string; model: string; costUsd?: number; taskId: string }
}

export interface VideoGenerateInput {
  prompt: string
  /** 显式指定模型（如 doubao-seedance-2.5）；缺省用 provider 配置的 defaultModel。 */
  model?: string
  /** First-frame / reference image URLs or base64 (max 30; Seedance 2.0 上限 9). */
  imageUrls?: string[]
  /** Role-tagged images (first_frame / last_frame / reference_image). 与 imageUrls 互斥，使用后不可再用 videoUrls/audioUrls。 */
  imageWithRoles?: unknown[]
  /** Reference video URLs (max 10; Seedance 2.0 上限 3). */
  videoUrls?: string[]
  /** Reference audio URLs (max 10; Seedance 2.5 新增能力). */
  audioUrls?: string[]
  /** Duration in seconds, 4-30, default 5 (Seedance 2.5 上限 30; 2.0 上限 15). */
  duration?: number
  /** Ratio 16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 21:9（视频编辑用 adaptive）. */
  size?: string
  /** Resolution 480p | 720p | 1080p. */
  resolution?: string
  /** Generate an audio-carrying video. */
  generateAudio?: boolean
  /** Return the last frame (for continuous video). */
  returnLastFrame?: boolean
  /** Generation mode: 'reference'（默认）| 'video_edit'（Seedance 2.5 视频编辑）. */
  generationType?: string
  /** Output container: 'mp4'（默认）| 'mov'（Seedance 2.5）. */
  outputFormat?: string
  /** Task-terminal callback URL (POST notification on completion). */
  callbackUrl?: string
  watermark?: boolean
  seed?: number
  extra?: Record<string, unknown>
}

/**
 * A submitted video task handle (provider-agnostic minimal contract): just the
 * `taskId` plus a `poll()` returning normalized abstract terminal/progress
 * state.
 */
export interface VideoTaskHandle {
  taskId: string
  /** Poll once, returning a provider-agnostic abstract state. */
  poll(signal?: AbortSignal): Promise<VideoTaskPoll>
}

/**
 * Abstract poll result: the minimal cross-provider state. No provider-specific
 * fields live here (Maizi's `violation`/`queued`/`costUsd`/multi-URL stay in
 * the implementation).
 */
export interface VideoTaskPoll {
  /** Normalized state: `running` covers each provider's queued/processing. */
  status: 'running' | 'succeeded' | 'failed'
  /** Normalized progress (0-100); omit when the provider has no progress notion. */
  progress?: number
  /** Terminal result file URL (single value; providers collapse multi-URL). */
  resultUrl?: string
  /** Failure reason (provider-mapped), for model/log consumption. */
  errorMsg?: string
}

export abstract class VideoProvider {
  abstract readonly provider: string
  abstract readonly defaultModel: string

  /** Submit a task, returning a pollable handle (video is asynchronous). */
  abstract submit(input: VideoGenerateInput, signal?: AbortSignal): Promise<VideoTaskHandle>
  /** After polling to `succeeded`, land the final resource and return the unified result. */
  abstract finalize(
    handle: VideoTaskHandle,
    signal?: AbortSignal,
    onProgress?: (progress: MediaProgress) => void,
  ): Promise<VideoGenerationResult>
  /** Bounds this provider enforces for the given model (its default when omitted). */
  abstract caps(model?: string): VideoCaps
  /**
   * Estimated USD for one generation at this model, duration and resolution, or
   * `undefined` when this provider cannot price it.
   * @param model - the model the run used.
   * @param durationSeconds - the requested duration.
   * @param resolution - the requested resolution tier ('480p', '720p', '1080p').
   * @returns the estimated USD cost, or `undefined` when unpriceable.
   */
  abstract estimateCostUsd(model: string, durationSeconds: number, resolution: string): number | undefined
  /**
   * Probe this backend with the values a configuration form is looking at,
   * including a key that has not been saved.
   * @param draft - the values the form shows.
   * @returns whether the endpoint answered favorably, plus the human reason.
   */
  abstract probe(draft: ProviderProbeDraft): Promise<ProviderProbeResult>
  /** Connectivity test: no args, resolves the key internally. */
  abstract testConnection(): Promise<boolean>
}

/**
 * Optional model-catalogue capability of a video backend, declared as a merged
 * interface rather than an abstract member so a backend that cannot enumerate
 * its models simply does not implement it. Callers detect it structurally
 * (`typeof provider.listModels === 'function'`); an implementer declares its
 * members `override` because the merged members still belong to the class.
 */
export interface VideoProvider {
  /**
   * List the video models this backend offers right now, when it can enumerate
   * them.
   *
   * Vendor ids carry date segments and retire, so this is the only sound way to
   * learn what a deployment may actually request — a caller must not treat its
   * configured id as still valid. It is also the recovery path when a
   * submission is refused for an unknown or retired model id.
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the models the backend reports, or an empty list when it offers none.
   */
  listModels?(signal?: AbortSignal): Promise<MediaModelInfo[]>
  /**
   * List models against the values a configuration form is looking at — an
   * endpoint and an API key that have not been saved yet — when the backend can
   * use them. Companion to {@link VideoProvider.listModels}: a form asks with
   * its draft so a catalogue can be browsed, and a key validated, before
   * anything is stored. A backend that omits this is asked through
   * `listModels`, which reads the stored configuration.
   * @param draft - the endpoint and key the form holds; an empty field means
   * "use the configured value".
   * @param signal - cancellation forwarded to the model-list request.
   * @returns the models the backend reports.
   */
  listModelsWithDraft?(draft: ProviderProbeDraft, signal?: AbortSignal): Promise<MediaModelInfo[]>
}

/** Music generation input (Suno-style: inspiration OR custom mode). */
export interface MusicGenerateInput {
  /** 灵感模式：风格/情绪描述（与 `lyrics` 二选一，必须给一个）。 */
  description?: string
  /** 自定义模式：歌词内容（与 `description` 二选一）。 */
  lyrics?: string
  /** 自定义模式：音乐风格标签（如 "pop, rock, cinematic"）。 */
  tags?: string
  /** 排除的风格提示词。 */
  negativeTags?: string
  /** 模型版本（如 chirp-bluejay）；缺省用 provider 配置的默认模型。 */
  model?: string
  /** 歌名。 */
  title?: string
  /** 纯音乐（无人声）；BGM 场景建议 true。 */
  instrumental?: boolean
  /** 人声性别：`m` | `f`（无人声时忽略）。 */
  vocalGender?: string
  /** 风格参考度 0-1。 */
  styleWeight?: number
  /** 怪异约束度 0-1。 */
  weirdnessConstraint?: number
}

/** One submitted music task（一次生成通常返回 2 个候选）。 */
export interface MusicTaskHandle {
  taskId: string
  /** Poll once, returning a provider-agnostic abstract state. */
  poll(signal?: AbortSignal): Promise<MusicTaskPoll>
}

/** Abstract poll result for one music task. */
export interface MusicTaskPoll {
  status: 'running' | 'succeeded' | 'failed'
  /** Normalized progress (0-100) when the provider reports one. */
  progress?: number
  /** Failure reason (provider-mapped). */
  errorMsg?: string
}

/** Terminal track info for one completed task. */
export interface MusicTrackInfo {
  /** 24h-valid audio URL（mp3）。 */
  audioUrl: string
  /** Suno clip id（后续 extend/cover 等操作的主键）。 */
  clipId?: string
  /** Track duration in seconds（provider 报告）。 */
  durationSeconds?: number
  /** Cover image URL（provider 返回时）。 */
  coverUrl?: string
  /** Track title（provider 返回时）。 */
  title?: string
  /**
   * Same-origin signed local stream URL, present once the generation tool has
   * cached the audio on disk. The player prefers this over `audioUrl`, which
   * remains as the CDN fallback.
   */
  localUrl?: string
}

/** Music generation result: one completed candidate track（每个 job 对应一首候选）。 */
export interface MusicGenerationResult {
  kind: 'music'
  mediaType: 'audio/mpeg'
  /** 本 job 对应的完成曲目。 */
  track: MusicTrackInfo
  /** = [track]（数组形式便于与多候选工作流对齐）。 */
  tracks: MusicTrackInfo[]
  /** 本 job 的任务终态。 */
  tasks: Array<{ taskId: string; status: 'completed' | 'failed' | 'pending' }>
  providerMeta: { provider: string; model: string; costUsd?: number }
}

export abstract class MusicProvider {
  abstract readonly provider: string
  abstract readonly defaultModel: string

  /** Submit a generation request, returning all candidate task handles. */
  abstract submit(input: MusicGenerateInput, signal?: AbortSignal): Promise<MusicTaskHandle[]>
  /** Fetch the terminal track info for a task that polled `succeeded`. */
  abstract fetchTrack(taskId: string, signal?: AbortSignal): Promise<MusicTrackInfo>
  /**
   * Probe this backend with the values a configuration form is looking at,
   * including a key that has not been saved.
   * @param draft - the values the form shows.
   * @returns whether the endpoint answered favorably, plus the human reason.
   */
  abstract probe(draft: ProviderProbeDraft): Promise<ProviderProbeResult>
  /** Connectivity test: no args, resolves the key internally. */
  abstract testConnection(): Promise<boolean>
}
