/**
 * The `job_output` media row: renders a settled media-generation job's media
 * inline in the tool result card — an image through the session-authorized
 * loader (fast local attachment) or the provider URL, an inline
 * `<video controls>` for video, an `<audio controls>` player for music.
 * Video/audio prefer the generation job's signed local stream URL
 * (`mediaCacheUrl`) and fall back to the provider CDN link if that stream is
 * gone (host restarted) or unreachable.
 *
 * The model does not need to embed URLs or call read_image: reading the
 * completed job through `job_output` displays the media here. Every other
 * `job_output` shape falls back to the raw result text (a claimed keyed view
 * suppresses the generic card, so the text must stay visible here).
 * @module @roubaai/media/client/media-job-row
 */

import { useEffect, useState, type JSX } from 'react'
import { jobOutputMedia, type JobImageAttachment, type JobOutputMedia } from './job-output-media.ts'

/** The slice of the keyed toolview owner the row reads. */
export interface MediaJobRowProps {
  /** Frozen running call or settled result node. */
  block: unknown
  /**
   * Session-authorized image URL loader supplied by the chat node owner
   * (`ToolCallOwnerProps.loadImage`); present on composed tool views.
   */
  loadImage?: unknown
}

/** Runtime face of the session-authorized loader after the unknown cast. */
interface LoaderFace {
  (attachment: JobImageAttachment): Promise<string>
  peek?: (attachment: JobImageAttachment) => string | undefined
}

/** Tertiary caption style shared by every branch's label line. */
const captionStyle: Record<string, string> = {
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}

/** Whether the browser prefers Chinese (any zh-* tag). */
function isChinese(): boolean {
  return (navigator.language ?? '').toLowerCase().startsWith('zh')
}

/** Raw result text of a settled block (the fallback body). */
function resultText(block: unknown): string {
  const content = (block as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => typeof part === 'object' && part !== null && (part as Record<string, unknown>)['type'] === 'text'
      ? (part as Record<string, unknown>)['text'] as string
      : '')
    .filter((line) => line !== '')
    .join('\n')
}

/** Label per media kind (Chinese label when the browser prefers it). */
function mediaLabel(media: JobOutputMedia): string {
  const zh = isChinese()
  switch (media.kind) {
    case 'image':
      return zh ? '生成的图片' : 'Generated image'
    case 'video':
      return zh ? '生成的视频' : 'Generated video'
    case 'music':
      return media.title === undefined
        ? zh ? '生成的音乐' : 'Generated music'
        : `${zh ? '生成的音乐' : 'Generated music'} · ${media.title}`
  }
}

/** Resolve the loader from the opaque owner prop (no-op when absent). */
function loaderOf(loadImage: unknown): LoaderFace | undefined {
  return typeof loadImage === 'function' ? loadImage as LoaderFace : undefined
}

/** Load a session-authorized image URL, seeding from the loader's sync cache. */
function useAuthorizedImageUrl(loader: LoaderFace | undefined, attachment: JobImageAttachment | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() =>
    loader === undefined || attachment === undefined ? undefined : loader.peek?.(attachment))
  useEffect(() => {
    if (loader === undefined || attachment === undefined) {
      setUrl(undefined)
      return
    }
    let alive = true
    setUrl(loader.peek?.(attachment))
    loader(attachment).then(
      (next) => { if (alive) setUrl(next) },
      () => { if (alive) setUrl(undefined) },
    )
    return () => { alive = false }
  }, [loader, attachment])
  return url
}

/** The direct-link fallback line under a settled media (the URL can expire). */
function MediaLinkHint({ media }: { media: JobOutputMedia }): JSX.Element {
  const url = media.kind === 'music' ? media.audioUrl : media.url
  if (url === undefined) return <></>
  const isLocal = url.startsWith('/')
  return (
    <div style={{ ...captionStyle, marginTop: '6px' }}>
      {isLocal
        ? (isChinese() ? '已缓存本地 · 可离线播放' : 'cached locally · plays offline')
        : (isChinese() ? '链接 24 小时内有效' : 'link valid for 24h')}
      {isLocal ? null : (
        <>
          {' · '}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--dsw-alias-link-normal, #2563eb)' }}
          >
            {isChinese() ? '打开链接' : 'Open link'}
          </a>
        </>
      )}
    </div>
  )
}

/** Image body: session-authorized local URL when the attachment + loader exist, else the CDN URL. */
function ImageBody({ media, loadImage }: { media: Extract<JobOutputMedia, { kind: 'image' }>; loadImage?: unknown }): JSX.Element {
  const loader = loaderOf(loadImage)
  const authorized = useAuthorizedImageUrl(loader, media.attachment)
  const [cdnFailed, setCdnFailed] = useState(false)
  const src = authorized ?? (cdnFailed ? undefined : media.url)
  if (src === undefined) {
    return (
      <div style={{ ...captionStyle, padding: '8px 0' }}>{mediaLabel(media)}</div>
    )
  }
  return (
    <div>
      <img
        src={src}
        alt={mediaLabel(media)}
        onError={() => setCdnFailed(true)}
        style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px', display: 'block' }}
      />
      <MediaLinkHint media={media} />
    </div>
  )
}

/** Video body: plays the provider URL immediately, switches to the local stream when cached. */
function VideoBody({ media }: { media: Extract<JobOutputMedia, { kind: 'video' }> }): JSX.Element {
  return (
    <div>
      <video
        src={media.url}
        controls
        playsInline
        preload="auto"
        style={{ maxWidth: '100%', maxHeight: '480px', borderRadius: '8px', display: 'block' }}
      />
      <MediaLinkHint media={media} />
    </div>
  )
}

/** Music body: cover + player; plays the provider URL immediately, switches to the local stream when cached. */
function MusicBody({ media }: { media: Extract<JobOutputMedia, { kind: 'music' }> }): JSX.Element {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {media.coverUrl !== undefined ? (
          <img
            src={media.coverUrl}
            alt={mediaLabel(media)}
            style={{ width: '64px', height: '64px', objectFit: 'cover', borderRadius: '8px', flexShrink: 0 }}
          />
        ) : null}
        <audio
          src={media.audioUrl}
          controls
          preload="auto"
          style={{ width: 'min(100%, 480px)', display: 'block' }}
        />
      </div>
      <div style={{ ...captionStyle, marginTop: '4px' }}>{mediaLabel(media)}</div>
      <MediaLinkHint media={media} />
    </div>
  )
}

/**
 * Render the row: rich inline media for a settled media-generation job, raw
 * result text otherwise. The media body lives in this tool-result card — the
 * model never copies URLs into its reply text.
 * @param props - the owner slice the keyed slot supplies.
 * @returns the row element.
 */
export function MediaJobRow(props: MediaJobRowProps): JSX.Element {
  const { block, loadImage } = props
  const media = jobOutputMedia(block as Record<string, unknown>)

  // ── Settled media generation: inline media body. ──
  if (media !== null) {
    return (
      <div style={{ padding: '8px 0' }}>
        {media.kind === 'image' ? <ImageBody media={media} loadImage={loadImage} />
          : media.kind === 'video' ? <VideoBody media={media} />
            : <MusicBody media={media} />}
      </div>
    )
  }

  // ── Fallback: raw result text. ──
  const text = resultText(block)
  return (
    <div style={{ padding: '8px 0' }}>
      <pre style={{ margin: 0, fontSize: '12px', lineHeight: '18px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-tertiary, #6b7280)' }}>
        {text === '' ? (isChinese() ? '（无输出）' : '(no output)') : text}
      </pre>
    </div>
  )
}
