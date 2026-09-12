/**
 * Read-only routes over the workspace asset tree (`<root>/.assets/**`).
 *
 * The canvas workbench is a browser app: it can display a URL, not a path. These
 * two routes are what turn the asset tree into URLs — one to list a directory,
 * one to serve a file — so a canvas node can show an image or a video straight
 * out of `.assets` instead of importing a second copy into browser storage.
 *
 * The tree is the only thing exposed, and only below it: every request path is
 * resolved against `<root>/.assets` and refused when it leaves that directory,
 * so `..`, an absolute path or a drive letter never reaches the filesystem. The
 * listing answers with relative paths only — an absolute path is the one thing
 * the canvas deliberately keeps out of anything it sends to a model, and this
 * route has no reason to hand one out.
 *
 * Root resolution: `DSH_MEDIA_ASSETS_ROOT`, else the host's working directory.
 * One root per process is enough for a desktop host, which serves one workspace
 * at a time; a caller that needs another passes the configured root.
 *
 * @module @roubaai/media/asset-routes
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * Route prefix on the host webserver.
 *
 * A sibling of the media-cache prefix, not a child: the harness matches prefix
 * routes in registration order, so a child of `/api/roubaai-media` registered
 * after the cache route is never reached.
 */
export const ASSETS_ROUTE_PREFIX = '/api/roubaai-assets'

const TREE_PATH = '/tree'
const FILE_PATH = '/file'

/** Most entries one listing returns; a directory past this says it truncated. */
const MAX_ENTRIES = 500

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

type MediaKind = 'image' | 'video' | 'audio' | 'other'

function kindOf(ext: string): MediaKind {
  const mime = MIME[ext]
  if (mime === undefined) return 'other'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}

/** The directory this process serves: `<root>/.assets`. */
export function assetsRoot(): string {
  const root = process.env['DSH_MEDIA_ASSETS_ROOT'] ?? process.cwd()
  return join(resolve(root), '.assets')
}

/**
 * Resolve a request path inside the asset root, or undefined when it escapes.
 * @param requested - the caller's relative path (empty means the root itself).
 * @returns the absolute path, or undefined when the request is not confined.
 */
export function resolveAssetPath(requested: string): string | undefined {
  if (requested.includes('\0')) return undefined
  const cleaned = requested.replace(/^[\\/]+/, '')
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return undefined
  const root = assetsRoot()
  const target = resolve(root, cleaned)
  const prefix = root.endsWith(sep) ? root : root + sep
  return target === root || target.startsWith(prefix) ? target : undefined
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * One byte range out of a `Range` header, when it is a single satisfiable range.
 * @param header - the raw header value.
 * @param size - the file size, for clamping and for the `*` form.
 * @returns the inclusive byte window, or undefined to send the whole file.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return undefined
  const start = rawStart === '' ? Math.max(0, size - Number(rawEnd)) : Number(rawStart)
  const end = rawStart === '' || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return undefined
  return { start, end }
}

/** List one directory of the asset tree. */
async function serveTree(res: ServerResponse, requested: string): Promise<void> {
  const target = resolveAssetPath(requested)
  if (target === undefined) {
    sendJson(res, 400, { ok: false, error: 'path escapes the asset root' })
    return
  }
  let info
  try {
    info = await stat(target)
  } catch {
    sendJson(res, 404, { ok: false, error: 'directory not found' })
    return
  }
  if (!info.isDirectory()) {
    sendJson(res, 400, { ok: false, error: 'not a directory' })
    return
  }
  const dirents = await readdir(target, { withFileTypes: true })
  const entries: Array<Record<string, unknown>> = []
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    const relativePath = requested === '' ? dirent.name : `${requested.replace(/\/+$/, '')}/${dirent.name}`
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: relativePath, dir: true })
      continue
    }
    const file = await stat(join(target, dirent.name))
    const ext = extname(dirent.name).toLowerCase()
    entries.push({
      name: dirent.name,
      path: relativePath,
      dir: false,
      size: file.size,
      mtime: file.mtimeMs,
      kind: kindOf(ext),
    })
  }
  // Directories first, then by name, so the listing reads like a file browser.
  entries.sort((a, b) => {
    if (a['dir'] !== b['dir']) return a['dir'] === true ? -1 : 1
    return String(a['name']).localeCompare(String(b['name']))
  })
  sendJson(res, 200, {
    ok: true,
    path: requested,
    entries,
    truncated: dirents.length > MAX_ENTRIES,
  })
}

/** Stream one file of the asset tree, honouring a single byte range. */
async function serveFile(req: IncomingMessage, res: ServerResponse, requested: string): Promise<void> {
  const target = resolveAssetPath(requested)
  if (target === undefined) {
    sendJson(res, 400, { ok: false, error: 'path escapes the asset root' })
    return
  }
  let info
  try {
    info = await stat(target)
  } catch {
    sendJson(res, 404, { ok: false, error: 'file not found' })
    return
  }
  if (!info.isFile()) {
    sendJson(res, 400, { ok: false, error: 'not a file' })
    return
  }
  const headers: Record<string, string> = {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=60',
  }
  const range = parseRange(req.headers.range, info.size)
  if (range === undefined) {
    res.writeHead(200, { ...headers, 'content-length': String(info.size) })
    createReadStream(target).pipe(res)
    return
  }
  res.writeHead(206, {
    ...headers,
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
  })
  createReadStream(target, { start: range.start, end: range.end }).pipe(res)
}

/**
 * Answer one asset-tree request.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param url - the parsed request URL.
 */
export async function handleAssetsRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const path = url.pathname.slice(ASSETS_ROUTE_PREFIX.length) || '/'
  const requested = url.searchParams.get('path') ?? ''
  if (path === TREE_PATH) {
    await serveTree(res, requested)
    return
  }
  if (path === FILE_PATH) {
    await serveFile(req, res, requested)
    return
  }
  sendJson(res, 404, { ok: false, error: `unknown asset path ${path}` })
}

/**
 * Register the asset routes on the host webserver.
 * @param ctx - the plugin context.
 * @returns the disposer removing the routes.
 */
export function registerAssetRoutes(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ASSETS_ROUTE_PREFIX,
    handler: (req, res): void => {
      void handleAssetsRequest(req, res, new URL(req.url ?? ASSETS_ROUTE_PREFIX, 'http://dsh.internal'))
    },
  })
}
