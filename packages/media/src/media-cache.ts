/**
 * Local media cache + signed same-origin stream routes.
 *
 * Generated video/audio URLs are provider CDNs (24h validity); streaming them
 * straight into the browser is slow and dies on expiry. This module mirrors
 * the host's attachment pattern for media: the bytes are pulled to the local
 * machine once (generation or `media_asset_save`) and the browser later plays
 * them from the harness itself — fast, seekable, offline of the provider.
 *
 * Design (same-origin, no extra port, no arbitrary file reads):
 * - Downloads run in the BACKGROUND after a generation job settles, so the job
 *   completes and the tool card appears immediately with the provider URL.
 * - Every cached file is registered here under its content hash; the stream
 *   route serves ONLY registered ids and demands an HMAC signature over
 *   `id:expiry`, so a cross-site page cannot read local files by path.
 * - The routes live on the host webserver (`/api/roubaai-media/...`) — the
 *   page's own origin — so `<video>`/`<audio>`/`<img>` load them without
 *   CORS/port issues, and the client can poll `lookup` to learn when the
 *   background download finished and switch the player source to local.
 *
 * A restarted host invalidates outstanding signatures (new per-process
 * secret); players then fall back to the provider URL they already carry.
 * @module @roubaai/media/media-cache
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

/** Route prefix on the host webserver. */
export const MEDIA_ROUTE_PREFIX = '/api/roubaai-media'
/** Pathname (under the prefix) serving one registered media file. */
const MEDIA_STREAM_PATH = '/media'
/** Pathname (under the prefix) answering whether one CDN URL is cached locally. */
const MEDIA_LOOKUP_PATH = '/lookup'
/** Signed URLs stay valid for the provider CDN window; a restarted host invalidates them anyway. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** Maximum bytes accepted from one provider download. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
/** Hard cap on one background download so a slow provider cannot pin a process. */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** One registered cache row: the local file and the MIME it is served as. */
interface CacheEntry {
  readonly file: string
  readonly mediaType: string
  readonly sourceUrl: string
}

const cacheById = new Map<string, CacheEntry>()
const cacheByUrl = new Map<string, string>()

let secret: Buffer | undefined

/**
 * The system-level media cache root. Every download lands here — a single,
 * process-independent directory (`$DSH_HOME/media-cache`, falling back to the
 * host cwd) shared across projects and restarts — so `restoreCacheFromDisk`
 * can rebuild the file mapping from one directory and the signature secret
 * stays consistent across every workspace. `DSH_MEDIA_CACHE_DIR` overrides it
 * for deployments with a pinned data dir.
 */
function cacheRoot(): string {
  const pinned = process.env.DSH_MEDIA_CACHE_DIR
  if (pinned !== undefined && pinned !== '') return pinned
  const home = process.env.DSH_HOME
  return home !== undefined && home !== ''
    ? join(home, 'media-cache')
    : join(process.cwd(), '.media-cache')
}

/**
 * The stream signature secret, persisted to disk so a restarted host keeps
 * serving previously minted local URLs (and the on-disk cache stays usable).
 * Created lazily so headless installs never write a secret file.
 */
function signingSecret(): Buffer {
  if (secret !== undefined) return secret
  const file = join(cacheRoot(), '.secret')
  try {
    if (existsSync(file)) {
      const hex = readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{64}$/i.test(hex)) {
        secret = Buffer.from(hex, 'hex')
        return secret
      }
    }
  } catch { /* unreadable/absent → mint a fresh one below */ }
  secret = randomBytes(32)
  try {
    mkdirSync(cacheRoot(), { recursive: true })
    writeFileSync(file, secret.toString('hex'))
  } catch { /* non-fatal: an unsigned process still serves until restart */ }
  return secret
}

/** MIME for a cached file extension (used to rebuild `cacheById` from disk). */
function mimeOfExt(ext: string): string | undefined {
  switch (ext) {
    case 'mp4': case 'm4v': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mov': return 'video/quicktime'
    case 'mp3': return 'audio/mpeg'
    case 'm4a': return 'audio/mp4'
    case 'wav': return 'audio/wav'
    case 'aac': return 'audio/aac'
    case 'ogg': case 'oga': return 'audio/ogg'
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return undefined
  }
}

/**
 * Rebuild `cacheById` from the cache dir so a restarted host keeps serving
 * previously minted local stream URLs. The signature secret now persists
 * across restarts, so the URL still validates — this restores the file→id
 * mapping that otherwise lives only in process memory. Files are named
 * `<id>.<ext>`, enough to recover the id and MIME; `sourceUrl` is unknown and
 * left empty (it is only used for a cache-eviction path, never for serving).
 */
function restoreCacheFromDisk(): void {
  const dir = cacheRoot()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === '.secret') continue
    const match = /^([0-9a-f]{24})\.([a-z0-9]+)$/i.exec(name)
    if (match === null) continue
    const id = match[1]
    const ext = match[2]
    if (id === undefined || ext === undefined) continue
    if (cacheById.has(id)) continue
    const mediaType = mimeOfExt(ext.toLowerCase())
    if (mediaType === undefined) continue
    cacheById.set(id, { file: join(dir, name), mediaType, sourceUrl: '' })
  }
}

/** Constant-time signature check over `id:exp`. */
function signatureValid(id: string, exp: string, sig: string): boolean {
  const expected = createHmac('sha256', signingSecret()).update(`${id}:${exp}`).digest()
  const received = Buffer.from(sig, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

/** Strip an extension to a safe disk fragment (no separators, empty → 'bin'). */
function safeExt(ext: string): string {
  const cleaned = ext.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return cleaned === '' ? 'bin' : cleaned
}

/** Content id of one source URL. */
function idOf(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24)
}

/** Build the signed same-origin stream URL for one cache id. */
function signedUrl(id: string): string {
  const exp = Date.now() + CACHE_TTL_MS
  // Full-length HMAC hex: the verifier compares the whole digest (32 bytes),
  // so a truncated signature would always reject with 403.
  const sig = createHmac('sha256', signingSecret())
    .update(`${id}:${exp}`)
    .digest('hex')
  return `${MEDIA_ROUTE_PREFIX}${MEDIA_STREAM_PATH}?id=${id}&exp=${exp}&sig=${sig}`
}

/** Pathname extension of a remote URL, if any. */
function pathExtension(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname
    const dot = pathname.lastIndexOf('.')
    return dot < 0 ? undefined : pathname.slice(dot + 1)
  } catch {
    return undefined
  }
}

/**
 * Fetch the remote bytes and write them under the cache dir.
 * @returns the written file path.
 */
async function downloadTo(url: string, dir: string, ext: string, signal: AbortSignal): Promise<string> {
  const init: RequestInit = { redirect: 'follow', signal }
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`download failed (HTTP ${String(response.status)})`)
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`payload exceeds the ${MAX_DOWNLOAD_BYTES}-byte cache cap`)
  }
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`payload exceeds the ${MAX_DOWNLOAD_BYTES}-byte cache cap`)
  }
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${idOf(url)}.${safeExt(ext)}`)
  await writeFile(file, data)
  return file
}

/** Register already-local bytes under their source URL (media_asset_save reuse). */
export function registerLocalMedia(options: {
  readonly url: string
  readonly filePath: string
  readonly mediaType: string
}): string | undefined {
  const { url, filePath, mediaType } = options
  const id = idOf(url)
  if (cacheById.has(id)) return signedUrl(id)
  cacheById.set(id, { file: filePath, mediaType, sourceUrl: url })
  cacheByUrl.set(url, filePath)
  return signedUrl(id)
}

/** Same-origin signed URL for a source URL this process already cached. */
export function lookupCachedMediaUrl(url: string): string | undefined {
  return cacheByUrl.has(url) ? signedUrl(idOf(url)) : undefined
}

/** Local file of a URL this process already cached (media_asset_save reuses it). */
export function cachedMediaFile(url: string): string | undefined {
  return cacheByUrl.get(url)
}

/** Re-read a cached file's bytes (media_asset_save reuse path). */
export async function cachedMediaBytes(url: string): Promise<Uint8Array | undefined> {
  const file = cacheByUrl.get(url)
  if (file === undefined) return undefined
  try {
    return new Uint8Array(await readFile(file))
  } catch {
    return undefined
  }
}

/**
 * Synchronously download one provider URL into the fixed cache dir and return
 * its same-origin signed stream URL. The caller (a generation tool) awaits
 * this BEFORE settling the job, so `job_output` already carries the local URL
 * and the player never touches the slow CDN. On any failure the promise
 * resolves to `undefined` and the caller falls back to the CDN URL it already
 * has — the job still completes.
 * @param options - provider URL, media MIME, extension fallback, diagnostics.
 * @returns the signed local stream URL, or undefined when caching failed.
 */
export async function downloadToCache(options: {
  readonly url: string
  readonly mediaType: string
  readonly fallbackExt: string
  readonly log?: (message: string) => void
}): Promise<string | undefined> {
  const { url, mediaType, fallbackExt, log } = options
  const already = lookupCachedMediaUrl(url)
  if (already !== undefined) return already
  const ext = pathExtension(url) ?? fallbackExt
  const dir = cacheRoot()
  let signal: AbortSignal
  try {
    signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  } catch {
    log?.('media cache: AbortSignal.timeout unavailable; CDN URL stays in use')
    return undefined
  }
  try {
    const file = await downloadTo(url, dir, ext, signal)
    return registerLocalMedia({ url, filePath: file, mediaType })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log?.(`media cache: download failed for ${url} (${reason}); CDN URL stays in use`)
    return undefined
  }
}

/**
 * Start a background download of one provider URL into the workspace cache.
 * Does NOT block the caller: the generation job settles immediately and the
 * client polls `lookup` until this finishes, then switches to the local stream.
 * @param options - workspace root, provider URL, media MIME, and diagnostics.
 */
export function cacheInBackground(options: {
  readonly workspace: string
  readonly url: string
  readonly mediaType: string
  readonly fallbackExt: string
  readonly log?: (message: string) => void
}): void {
  const { url, workspace, mediaType, fallbackExt, log } = options
  if (cacheByUrl.has(url)) return
  const ext = pathExtension(url) ?? fallbackExt
  const dir = join(workspace, '.media-cache')
  let signal: AbortSignal
  try {
    signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  } catch {
    log?.('media cache: AbortSignal.timeout unavailable')
    return
  }
  void downloadTo(url, dir, ext, signal).then(
    (file) => {
      registerLocalMedia({ url, filePath: file, mediaType })
      log?.(`media cache: registered ${idOf(url)} (${mediaType}) <- ${url}`)
    },
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      log?.(`media cache: background download failed for ${url} (${reason}); CDN URL stays in use`)
    },
  )
}

/** Range header parse: {start,end} in bytes, or undefined for a full response. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, startRaw, endRaw] = match
  if (startRaw === undefined || startRaw === '') return undefined
  const start = Number(startRaw)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return undefined
  const end = endRaw !== undefined && endRaw !== ''
    ? Math.min(Number(endRaw), size - 1)
    : size - 1
  if (!Number.isSafeInteger(end) || end < start) return undefined
  return { start, end }
}

/** Serve one registered cache file with Range + correct MIME. */
async function serveEntry(res: ServerResponse, entry: CacheEntry, req: IncomingMessage): Promise<void> {
  let size: number
  try {
    size = (await stat(entry.file)).size
  } catch {
    cacheById.delete(idOf(entry.sourceUrl))
    res.writeHead(404).end('missing')
    return
  }
  res.setHeader('content-type', entry.mediaType)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  const range = parseRange(req.headers.range, size)
  if (req.method === 'HEAD') {
    res.writeHead(range === undefined ? 200 : 206, {
      ...range === undefined ? { 'content-length': String(size) } : {
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'content-length': String(range.end - range.start + 1),
      },
    })
    res.end()
    return
  }
  if (range === undefined) {
    res.writeHead(200, { 'content-length': String(size) })
    createReadStream(entry.file).pipe(res)
    return
  }
  res.writeHead(206, {
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'content-length': String(range.end - range.start + 1),
  })
  createReadStream(entry.file, { start: range.start, end: range.end }).pipe(res)
}

/**
 * Register the same-origin media routes on the host webserver:
 * - `<prefix>/media?id=…&exp=…&sig=…` — signed stream of one registered file;
 * - `<prefix>/lookup?url=<cdn>` — JSON `{ mediaUrl }` when the URL is cached,
 *   else `{ mediaUrl: null }` (the client polls this to switch to local).
 * @param webServer - the host webserver service (routes share its origin).
 * @returns the disposer removing the routes.
 */
export function registerWebRoutes(webServer: {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}): () => void {
  // Restore the file→id mapping from the cache dir once, so local stream URLs
  // minted by a previous process keep working after a host restart.
  restoreCacheFromDisk()
  const disposer = webServer.register({
    kind: 'prefix',
    path: MEDIA_ROUTE_PREFIX,
    handler: (req, res): void => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          const pathname = url.pathname.slice(MEDIA_ROUTE_PREFIX.length) || '/'
          if (pathname === MEDIA_STREAM_PATH) {
            const id = url.searchParams.get('id') ?? ''
            const exp = url.searchParams.get('exp') ?? ''
            const sig = url.searchParams.get('sig') ?? ''
            const entry = cacheById.get(id)
            if (entry === undefined || !signatureValid(id, exp, sig) || Number(exp) < Date.now()) {
              res.writeHead(403).end('forbidden')
              return
            }
            await serveEntry(res, entry, req)
            return
          }
          if (pathname === MEDIA_LOOKUP_PATH) {
            const source = url.searchParams.get('url')
            const mediaUrl = source === null ? undefined : lookupCachedMediaUrl(source)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ mediaUrl: mediaUrl ?? null }))
            return
          }
          res.writeHead(404).end('not found')
        } catch {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        }
      })()
    },
  })
  return disposer
}
