/**
 * `media_asset_save` tool: persist an AI-generated image or video (or an
 * uploaded reference image) into the current session's on-disk asset library,
 * under a deterministic category path and a friendly name, then append an
 * entry to the asset index.
 *
 * Assets live on disk (not as URLs) so they survive provider URL expiry (24h)
 * and tunnel-domain changes; later video-generation steps re-publish a needed
 * asset to a fresh public URL with `media_reference_url`.
 *
 * The save runs in the background (`ctx.jobs`), mirroring `generate_image`:
 * `execute` returns immediately with a job id, and the bytes are fetched and
 * written asynchronously. On completion a message is delivered to the owner's
 * session with the saved path.
 *
 * The asset root is the user's library (`$DSH_HOME/assets`, resolved by
 * `../asset-root.ts`), not the session's working directory: an asset belongs to
 * the user and outlives the conversation that produced it, and the canvas
 * library reads the same tree.
 *   `<assetsRoot>/<project>/<dir>/<name>.png|.mp4`
 *   `<assetsRoot>/<project>/assets-index.md`
 *
 * The `reference` parameter accepts every shape the model may actually have in
 * context: an attachment JSON object, a host-local image URL, a host-local
 * video URL, a public https URL, a local path, a bare sha256 id, or a Markdown
 * image reference. The tool figures out the type and saves the bytes.
 *
 * @module @roubaai/media/tools/media-asset-save
 */

import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { cachedMediaBytes } from '../media-cache.ts'
import { assetsRoot } from '../asset-root.ts'
import { ASSET_CATEGORIES, isAssetCategory, landMediaAsset, resolveLandingPath } from '../asset-landing.ts'

export const name = 'media_asset_save'

/** DSH host base URL used to resolve host-local `/...` references. */
const HOST_BASE = (process.env.DSH_MEDIA_HOST ?? 'http://127.0.0.1:3080').replace(/\/$/, '')

/** Allowed asset categories (English ids; 项目名等用户指定内容才用中文). */
const CATEGORIES = ASSET_CATEGORIES

type ResolvedSource =
  | { kind: 'attachment'; ref: ImageAttachmentRef; publicUrl?: string }
  /** A bare content-addressed id: bytes live in the local attachment store;
   *  resolved eagerly (host path + sniffed type) before the job starts. */
  | { kind: 'attachment-id'; attachmentId: string }
  | { kind: 'stored-image'; data: Uint8Array; mediaType: string; publicUrl?: string }
  | { kind: 'url'; url: string }
  | { kind: 'local'; path: string; publicUrl?: string }

/** The media types a stored attachment may claim, with their file extensions. */
const STORED_MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Sniff the image media type from magic bytes. The attachment store content-
 * addresses by sha256, so a bare id arrives without its media type; the stored
 * bytes themselves are the source of truth.
 * @param data - the stored bytes.
 * @returns the sniffed media type, or image/png when unrecognized.
 */
function sniffStoredMediaType(data: Uint8Array): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return 'image/png'
}

/** Normalize any reference shape the model may have into a fetchable/readable source. */
export function resolveSource(input: string): ResolvedSource | undefined {
  // Strip a Markdown image wrapper: ![alt](url)
  const md = /!\[[^\]]*\]\(([^)]+)\)/.exec(input)
  const value = (md?.[1] ?? input).trim()

  // 1. attachment JSON object — two shapes the model actually produces:
  //    a. flat ImageAttachmentRef: {"attachmentId":...,"mediaType":...,"bytes":...}
  //    b. mediaRef wrapper (the exact shape generate_image/generate_video emit):
  //       {"kind":"image","attachmentRef":"sha256:...","attachment":{...},"providerMeta":{...}}
  //       The wrapper's top level has no attachmentId — reach into `.attachment`.
  //    A provider result URL (24h validity) may ride alongside in `resultUrl`
  //    or `mediaRef.url`; it is captured as `publicUrl` for the asset index.
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      const flat = parsed as unknown as ImageAttachmentRef
      const pub = jsonPublicUrl(parsed)
      const withUrl = { ...(pub !== undefined ? { publicUrl: pub } : {}) }
      if (typeof flat.attachmentId === 'string' && typeof flat.mediaType === 'string') {
        return { kind: 'attachment', ref: flat, ...withUrl }
      }
      const nested = parsed.attachment as ImageAttachmentRef | undefined
      if (
        nested !== undefined && typeof nested === 'object'
        && typeof nested.attachmentId === 'string' && typeof nested.mediaType === 'string'
      ) {
        return { kind: 'attachment', ref: nested, ...withUrl }
      }
      // Video mediaRef wrapper: {"kind":"video","mediaRef":{"url":...}} — the
      // video has no landed attachment to read; its URL is the fetchable ref.
      const mediaRef = parsed.mediaRef as { url?: unknown } | undefined
      if (mediaRef !== undefined && typeof mediaRef === 'object' && typeof mediaRef.url === 'string' && mediaRef.url.length > 0) {
        return { kind: 'url', url: mediaRef.url }
      }
    } catch { /* not JSON */ }
  }

  // 2. public https URL (image or video)
  if (/^https:\/\//i.test(value)) {
    return { kind: 'url', url: value }
  }

  // 3. host-local absolute URL: /describe-image/raw/... or /api/media.stream/...
  if (value.startsWith('/')) {
    return { kind: 'url', url: `${HOST_BASE}${value}` }
  }

  // 4. local file path (Windows drive / file:// )
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return { kind: 'local', path: value }
  }
  if (value.startsWith('file://')) {
    return { kind: 'local', path: value.replace(/^file:\/\//, '') }
  }

  // 5. bare content-addressed id: bytes come from the local attachment store,
  //    resolved by the caller (needs the async attachments service).
  if (/^sha256:[0-9a-f]{8,64}$/.test(value)) {
    return { kind: 'attachment-id', attachmentId: value }
  }

  return undefined
}

/**
 * Eagerly resolve a bare content-addressed id into stored bytes: the id keys
 * the local attachment store directly (`imageHostPath` validates the id and
 * derives the object path), so no host HTTP route and no re-download is
 * involved.
 * @param ctx - the plugin context carrying the attachments service.
 * @param value - the bare `sha256:...` id.
 * @returns the stored bytes with their sniffed media type, or undefined when
 *   the service cannot resolve host paths (a non-file backend) or the object
 *   is missing.
 */
async function storedImageBytes(ctx: Context, value: string): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return undefined
  const placeholder = {
    attachmentId: value,
    mediaType: 'image/png',
    bytes: 0,
    width: 0,
    height: 0,
  } as ImageAttachmentRef
  // `imageHostPath` validates the id and derives the object path; the other
  // reference fields are unused by the path derivation.
  const hostPath = attachments.imageHostPath(placeholder)
  if (hostPath === undefined) return undefined
  try {
    const data = new Uint8Array(await readFile(hostPath))
    return { data, mediaType: sniffStoredMediaType(data) }
  } catch {
    return undefined
  }
}

/**
 * Pull the provider's 24h result URL out of a mediaRef-wrapper JSON, so the
 * asset index can record it even when the save itself runs off the local
 * attachment library. Checks `resultUrl` (image landed path) and
 * `mediaRef.url` (video / degraded image); host-local and non-https values
 * are skipped — the index column means a provider/public URL.
 */
function jsonPublicUrl(parsed: Record<string, unknown>): string | undefined {
  const candidates = [parsed.resultUrl, (parsed.mediaRef as { url?: unknown } | undefined)?.url]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https:\/\//i.test(candidate)) return candidate
  }
  return undefined
}

export function registerMediaAssetSave(ctx: Context): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name,
    description: 'Persist a generated image/video (or an uploaded reference) into the project asset library so it survives URL expiry and can be reused. Background job: returns a job id, message posts when done. Call after generate_image/generate_video when you want to keep the asset, or to save an uploaded reference. reference accepts any form you have in context (Markdown image, attachment JSON from job output, host URL, public https URL, sha256 id, or local path; video → its mediaRef url).',
    parameters: {
      reference: {
        type: 'string',
        required: true,
        description: 'The image/video to persist: Markdown image, attachment JSON from job output, host URL (/describe-image/raw/... or /api/media.stream/...), public https URL, sha256 id, or local path. Video → its mediaRef url.',
      },
      project: {
        type: 'string',
        required: true,
        description: 'Project folder name. The asset is saved under `<workspace>/.assets/<project>/`.',
      },
      category: {
        type: 'string',
        enum: [...CATEGORIES],
        required: true,
        description: 'Asset category: assets-index 类别标签（目录由 dir 决定）。upload (用户原图) / character / scene / prop / keyframe / video (视频成片；多集 name 用 EPxx/ 子路径，如 EP01/镜01_巨兽冲进广场) / meta (导演工作图与示意类图片，如情绪曲线；非资产，不参与生成、不作参考图) / cover. storyboard 已弃用（历史兼容），新视频一律 video。',
      },
      dir: {
        type: 'string',
        required: true,
        description: '落盘子目录（相对 `.assets/<project>/`，决定最终路径），由 LLM 按项目实际结构传参，如 `01_角色/CH001_花十/02_定稿图`。不得含 `..`、盘符或前导 `/`。',
      },
      name: {
        type: 'string',
        required: true,
        description: 'Friendly file base name without extension. May include sub-paths with `/` to organize assets, e.g. `小美/服装/礼服` becomes `<dir|category>/小美/服装/礼服.png`; plain names like `肉宝_三视图_v1` stay flat. Must not contain `..` or drive letters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          target: { type: 'string', required: true, description: 'Planned destination path.' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Started background asset-save job ${value.jobId}; saving to ${value.target}` },
      ],
    },
    // oxlint-disable-next-line typescript/require-await -- async matches the ToolDefinition.execute contract
    async execute(args, exec) {
      let source = resolveSource(args.reference)
      if (source === undefined) {
        throw new Error('media_asset_save: could not resolve the reference into an image or video; pass a Markdown image, attachment JSON, host URL (/describe-image/raw/... or /api/media.stream/...), public https URL, sha256 id, or local path')
      }
      // A bare sha256 id resolves eagerly from the local attachment store: the
      // bytes are already on disk, so no host route and no download is needed.
      if (source.kind === 'attachment-id') {
        const stored = await storedImageBytes(ctx, source.attachmentId)
        if (stored === undefined) {
          throw new Error(`media_asset_save: attachment ${source.attachmentId} is not in the local attachment store; pass the full attachment JSON from the job output instead`)
        }
        source = { kind: 'stored-image', data: stored.data, mediaType: stored.mediaType }
      }
      const category = args.category
      if (!isAssetCategory(category)) {
        throw new Error(`media_asset_save: unsupported category ${category}; use one of ${CATEGORIES.join(', ')}`)
      }

      const assets = assetsRoot()
      const isVideo = source.kind === 'url'
        ? isVideoUrl(source.url)
        : source.kind === 'attachment' ? source.ref.mediaType.includes('video') : false
      const isAudio = !isVideo && (source.kind === 'url'
        ? isAudioUrl(source.url)
        : source.kind === 'attachment' ? source.ref.mediaType.includes('audio') : false)
      const ext = source.kind === 'stored-image'
        ? STORED_MEDIA_EXTENSIONS[source.mediaType] ?? 'png'
        : isVideo ? 'mp4' : isAudio ? 'mp3' : 'png'
      // Resolve (and validate) the destination before the job starts, so a bad
      // name or directory fails the call instead of an invisible background job.
      const { filePath, safeDir, safeName } = resolveLandingPath({ assetsRoot: assets, project: args.project, dir: args.dir, name: args.name, ext }, 'media_asset_save')

      const jobId = ctx.jobs.start({
        kind: 'media-asset',
        label: `media_asset_save:${safeDir}/${safeName}`,
        ...exec.agent !== undefined ? { owner: exec.agent } : {},
        run: () => {
          const ac = new AbortController()
          const done = (async (): Promise<{ status: 'completed' | 'failed'; output?: string; detail?: string }> => {
            try {
              const data = await fetchBytes(ctx, source, ac.signal)
              // One landing path for both this tool and the canvas facade; the
              // display URL is registered so the same-origin stream route serves
              // THIS copy rather than going back to the provider.
              const landed = await landMediaAsset({
                assetsRoot: assets,
                project: args.project,
                dir: args.dir,
                name: args.name,
                ext,
                bytes: data,
                category,
                reference: args.reference,
                // Prefer a URL carried inside the reference JSON (resultUrl /
                // mediaRef.url) over a bare https scan of the raw text.
                url: (source.kind === 'url' ? source.url : source.publicUrl) ?? extractPublicUrl(args.reference),
                displayUrl: source.kind === 'url' ? source.url : source.publicUrl,
              })
              return { status: 'completed', output: JSON.stringify({ path: landed.path, sizeBytes: landed.bytes, mediaType: ext }) }
            } catch (error) {
              if (ac.signal.aborted) return { status: 'failed', detail: 'aborted' }
              return { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
            }
          })()
          return { cancel: (reason?: string) => { ac.abort(reason) }, done }
        },
      })
      return { kind: 'background' as const, jobId, target: filePath }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Save asset ${args.name}`,
        kind: 'execute',
        rawInput: `${args.dir}/${args.name}`,
      }
    },
  })))

  // No completion followup: the model reads the saved path through
  // `job_output`. A pushed "已保存到资产库" message would pile up in the
  // session's queued-message tray and force extra model turns.

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** True when a URL looks like a video source (host media.stream or a .mp4/… public URL). */
function isVideoUrl(url: string): boolean {
  return /\/api\/media\.stream\//i.test(url)
    || /\.mp4(\?|$)/i.test(url)
    || /\/videos?\//i.test(url)
}

/** True when a URL looks like an audio source (.mp3/.wav — e.g. Suno CDN track URLs). */
function isAudioUrl(url: string): boolean {
  return /\.mp3(\?|$)/i.test(url)
    || /\.wav(\?|$)/i.test(url)
    || /\.m4a(\?|$)/i.test(url)
}

/** Fetch/read the bytes for a resolved source. */
async function fetchBytes(ctx: Context, source: ResolvedSource, signal?: AbortSignal): Promise<Uint8Array> {
  switch (source.kind) {
    case 'attachment': {
      const stored = await ctx.attachments.readImage(source.ref, signal)
      return stored.data
    }
    case 'stored-image': {
      return source.data
    }
    case 'url': {
      // The generation job already cached this URL locally (generate_video /
      // generate_music download once into the process cache): reuse those
      // bytes instead of re-downloading the provider CDN.
      const cached = await cachedMediaBytes(source.url)
      if (cached !== undefined) return cached
      const resp = await fetch(source.url, signal !== undefined ? { signal } : undefined)
      if (!resp.ok) {
        throw new Error(`media_asset_save: download failed (HTTP ${resp.status}) for ${source.url}`)
      }
      return new Uint8Array(await resp.arrayBuffer())
    }
    case 'local': {
      return new Uint8Array(await readFile(source.path))
    }
    default: {
      // A future ResolvedSource kind must not silently fall through to an
      // undefined return: name the unhandled kind instead.
      throw new Error(`media_asset_save: unsupported source kind ${String((source as { kind?: unknown }).kind)}`)
    }
  }
}

/** Extract a public https URL from a reference value, if present. */
export function extractPublicUrl(reference: string): string | undefined {
  const md = /!\[[^\]]*\]\(([^)]+)\)/.exec(reference)
  const value = md?.[1] ?? reference
  return /^https:\/\//i.test(value) ? value : undefined
}

/** Append one line to the project asset index (re-exported from the landing module). */
export { appendIndex } from '../asset-landing.ts'

export default registerMediaAssetSave
