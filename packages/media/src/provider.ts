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
  /** Provider raw return (URL / taskId), for logs and replay. */
  providerMeta: { provider: string; model: string; costUsd?: number }
}

export interface ImageGenerateInput {
  prompt: string
  /** Reference image URLs to guide/edit the generation (max 9; the provider truncates). */
  refImages?: string[]
  width?: number
  height?: number
  /** Aspect ratio like '1:1' | '16:9'; mutually exclusive with width/height. */
  aspectRatio?: string
  /** Resolution '1K' | '2K' | '4K'. */
  resolution?: string
  /** Quality 'low' | 'medium' | 'high'. */
  quality?: string
  /** Provider-specific parameter passthrough. */
  extra?: Record<string, unknown>
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

  /** Connectivity test (config UI / diagnostics): no args, resolves the key internally. */
  abstract testConnection(): Promise<boolean>
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
  /** Connectivity test: no args, resolves the key internally. */
  abstract testConnection(): Promise<boolean>
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
  /** Connectivity test: no args, resolves the key internally. */
  abstract testConnection(): Promise<boolean>
}
