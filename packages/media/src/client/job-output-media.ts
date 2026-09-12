/**
 * Pure derivation: the media one settled `job_output` carries when the job
 * behind it is a completed media generation (image / video / music).
 *
 * `generate_*` tools run as background jobs whose output is
 * `JSON.stringify(<GenerationResult>)`. The model reads that JSON through
 * `job_output` as plain text — the chat stream has no media block to render —
 * so this module recovers the displayable media from the text and lets the
 * client half show it without a follow-up round trip.
 *
 * - image: a landed attachment reference plus the provider's 24h result URL.
 *   The card renders the attachment through the session-authorized image
 *   loader when one is supplied (fast, local) and falls back to the CDN URL.
 * - video / music: a provider CDN https URL (24h validity) rendered by direct
 *   `<video>`/`<audio>` playback. When the generation job cached the media
 *   locally it also carries `mediaCacheUrl` — a signed loopback stream URL the
 *   card prefers (fast); the CDN URL remains as the fallback.
 *
 * Every field arrives unvalidated (an old log, a failed job, a different job
 * kind), so any mismatch declines to null and the toolview falls back to the
 * raw result text. Attachment ids are checked for existence only: they are
 * opaque and provider-owned.
 * @module @roubaai/media/client/job-output-media
 */

/** Minimal durable image reference face the loader needs (subset of ImageAttachmentRef). */
export interface JobImageAttachment {
  readonly attachmentId: string
  readonly mediaType: string
}

/**
 * One displayable media outcome of a settled media-generation `job_output`.
 * Every branch carries either a local/authorized render source or a public
 * https URL the browser can render directly.
 */
export type JobOutputMedia =
  | {
    readonly kind: 'image'
    /** Landed attachment for the session-authorized loader, when present. */
    readonly attachment?: JobImageAttachment
    /** Provider 24h CDN URL, used when no loader/attachment is available. */
    readonly url?: string
  }
  | {
    readonly kind: 'video'
    /** Provider 24h CDN URL (plays first; the card switches to the local stream when cached). */
    readonly url: string
    readonly mediaType: string
  }
  | {
    readonly kind: 'music'
    /** Provider 24h CDN URL (plays first; the card switches to the local stream when cached). */
    readonly audioUrl: string
    readonly coverUrl?: string
    readonly title?: string
    readonly durationSeconds?: number
  }

/** Whether a wire value is a public https URL the browser can render directly. */
function publicHttpsUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('https://') && value.length > 'https://'.length
    ? value
    : undefined
}

/**
 * Whether a wire value is the host's same-origin local media stream URL
 * (`/api/roubaai-media/media?...`). The generation tools put this in
 * `mediaRef.localUrl` / `track.localUrl` once the bytes are cached on disk.
 */
function localStreamUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('/api/roubaai-media/media')
    ? value
    : undefined
}

/**
 * Whether a finite positive integer (a bogus duration declines to undefined).
 * @param value - the unvalidated wire value.
 * @returns true when the value is a finite positive integer.
 */
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value > 0
}

/** Join the text of every text block of a settled result. */
function contentText(block: { content?: unknown }): string {
  const content = block['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'object' && part !== null
      && (part as Record<string, unknown>)['type'] === 'text'
      && typeof (part as Record<string, unknown>)['text'] === 'string') {
      parts.push((part as Record<string, unknown>)['text'] as string)
    }
  }
  return parts.join('\n')
}

/**
 * Narrow the image branch: the landed attachment (loader path) plus the
 * provider's original result URL (CDN fallback). The toolview renders the
 * attachment through the session-authorized loader when it can.
 */
function imageOf(result: Record<string, unknown>): JobOutputMedia | null {
  if (result['kind'] !== 'image') return null
  const mediaRef = result['mediaRef']
  const mediaUrl = typeof mediaRef === 'object' && mediaRef !== null
    ? (mediaRef as Record<string, unknown>)['url']
    : undefined
  const url = publicHttpsUrl(result['resultUrl']) ?? publicHttpsUrl(mediaUrl)
  const rawAttachment = result['attachment']
  const attachment = typeof rawAttachment === 'object' && rawAttachment !== null
    && typeof (rawAttachment as Record<string, unknown>)['attachmentId'] === 'string'
    && typeof (rawAttachment as Record<string, unknown>)['mediaType'] === 'string'
    ? {
      attachmentId: (rawAttachment as Record<string, unknown>)['attachmentId'] as string,
      mediaType: (rawAttachment as Record<string, unknown>)['mediaType'] as string,
    }
    : undefined
  if (attachment === undefined && url === undefined) return null
  return {
    kind: 'image',
    ...(attachment === undefined ? {} : { attachment }),
    ...(url === undefined ? {} : { url }),
  }
}

/** Narrow the video branch: a provider CDN mp4 URL behind `mediaRef`, plus the cached local stream when present. */
function videoOf(result: Record<string, unknown>): JobOutputMedia | null {
  if (result['kind'] !== 'video') return null
  const mediaRef = result['mediaRef']
  if (typeof mediaRef !== 'object' || mediaRef === null) return null
  const record = mediaRef as Record<string, unknown>
  const url = localStreamUrl(record['localUrl']) ?? publicHttpsUrl(record['url'])
  if (url === undefined) return null
  const mediaType = typeof record['mediaType'] === 'string' && record['mediaType'] !== ''
    ? record['mediaType'] as string
    : 'video/mp4'
  return { kind: 'video', url, mediaType }
}

/** Narrow the music branch: a Suno CDN mp3 behind `track.audioUrl`, plus the cached local stream when present. */
function musicOf(result: Record<string, unknown>): JobOutputMedia | null {
  if (result['kind'] !== 'music') return null
  const track = result['track']
  if (typeof track !== 'object' || track === null) return null
  const record = track as Record<string, unknown>
  const audioUrl = localStreamUrl(record['localUrl']) ?? publicHttpsUrl(record['audioUrl'])
  if (audioUrl === undefined) return null
  const coverUrl = publicHttpsUrl(record['coverUrl'])
  const title = typeof record['title'] === 'string' && record['title'] !== ''
    ? record['title'] as string
    : undefined
  const durationSeconds = positiveInteger(record['durationSeconds'])
    ? record['durationSeconds']
    : undefined
  return {
    kind: 'music',
    audioUrl,
    ...(coverUrl === undefined ? {} : { coverUrl }),
    ...(title === undefined ? {} : { title }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  }
}

/**
 * Recover the displayable media one settled `job_output` carries.
 * @param block - the frozen settled result node (a record with `content`).
 * @returns the media outcome, or null when this output is not a completed
 *   media generation.
 */
export function jobOutputMedia(block: Record<string, unknown>): JobOutputMedia | null {
  if (block['isError'] === true) return null
  const text = contentText(block)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const result = parsed as Record<string, unknown>
  return imageOf(result) ?? videoOf(result) ?? musicOf(result)
}
