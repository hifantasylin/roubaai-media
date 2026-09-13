/**
 * Read-only routes over the workspace asset tree (`<root>/.assets/**`).
 *
 * The canvas workbench is a browser app: it can display a URL, not a path. These
 * routes are what turn the asset tree into URLs — list a directory, list the
 * whole tree, serve a file — so a canvas node can show an image or a video
 * straight out of `.assets` instead of importing a second copy into browser
 * storage, and the canvas' asset library can browse projects without walking
 * the filesystem from the browser.
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
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { landMediaAsset, type LandedAsset } from './asset-landing.ts'
import { fileFields, parseMultipart, textField } from './multipart.ts'

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
/** Lists the projects that carry a production blueprint, newest first. */
const BLUEPRINTS_PATH = '/blueprints'
/** The whole tree in one answer, for a page that browses projects rather than directories. */
const LIBRARY_PATH = '/library'
/** Accepts uploaded files into a project. */
const UPLOAD_PATH = '/upload'
/** Where an upload lands when the caller does not say. */
const DEFAULT_UPLOAD_DIR = '08_上传'

/** Most bytes one upload request may carry. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
/** The file a project's blueprint lives in. */
const BLUEPRINT_FILE = 'canvas-blueprint.json'

/** Most entries one listing returns; a directory past this says it truncated. */
const MAX_ENTRIES = 500

/** Most files one library answer carries; past this the answer truncates. */
const MAX_LIBRARY_FILES = 4000

/** How deep the library walk descends below one project. */
const MAX_LIBRARY_DEPTH = 6

/**
 * The tree's own bookkeeping files. `asset-landing` writes the index and the
 * cost ledger writes the ledger; neither is an asset a library should show.
 */
const BOOKKEEPING = new Set(['assets-index.md', 'media-cost.jsonl'])

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

/**
 * List the projects that carry a blueprint, newest first.
 *
 * The canvas uses this to fill an empty canvas with the plan that was just
 * written, without being told which project: the newest blueprint is the one the
 * host produced for the work at hand.
 * @param res - the response to write.
 */
async function serveBlueprints(res: ServerResponse): Promise<void> {
  const root = assetsRoot()
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    sendJson(res, 200, { ok: true, blueprints: [] })
    return
  }
  const blueprints: Array<{ project: string; mtime: number; bytes: number }> = []
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    if (!dirent.isDirectory()) continue
    const file = join(root, dirent.name, BLUEPRINT_FILE)
    try {
      const info = await stat(file)
      if (info.isFile()) blueprints.push({ project: dirent.name, mtime: info.mtimeMs, bytes: info.size })
    } catch {
      // A project without a blueprint is the ordinary case, not an error.
    }
  }
  blueprints.sort((a, b) => b.mtime - a.mtime)
  sendJson(res, 200, { ok: true, blueprints })
}

/**
 * Read a request body, refusing anything past the upload cap.
 * @param req - the incoming request.
 * @returns the body bytes, or undefined when it is missing, failed, or oversized.
 */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return await new Promise<Buffer | undefined>((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: Buffer | undefined): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) {
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks)))
    req.on('error', () => finish(undefined))
  })
}

/**
 * Land one uploaded file into a project.
 *
 * The write goes through `asset-landing`, so an upload lands exactly where a
 * generated file lands: same path rules, same category vocabulary, same index
 * row. That is the whole point — an asset added by hand and one produced by a
 * run must be the same kind of thing.
 * @param project - project folder under `.assets`.
 * @param dir - sub-directory to file into.
 * @param filename - the uploaded name, whose extension is kept.
 * @param bytes - the file bytes.
 * @returns where it landed.
 */
async function landUpload(project: string, dir: string, filename: string, bytes: Buffer): Promise<LandedAsset> {
  const ext = extname(filename).replace(/^\./, '').toLowerCase() || 'bin'
  const name = filename.slice(0, filename.length - extname(filename).length) || 'asset'
  return await landMediaAsset({
    workspace: dirname(assetsRoot()),
    project,
    dir,
    name,
    ext,
    bytes,
    category: 'upload',
    reference: '',
  })
}

/**
 * Accept an upload into the asset tree.
 *
 * The body is `multipart/form-data` with a `project` field, an optional `dir`
 * field, and one or more `file` parts. Refusals are the landing module's own:
 * a project or directory that escapes `.assets` is rejected rather than
 * sanitized.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
async function serveUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  if (body === undefined) {
    sendJson(res, 413, { ok: false, error: `body missing or past ${MAX_UPLOAD_BYTES} bytes` })
    return
  }
  const parts = parseMultipart(req.headers['content-type'], body)
  const project = textField(parts, 'project')
  if (project === undefined) {
    sendJson(res, 400, { ok: false, error: 'project is required' })
    return
  }
  const dir = textField(parts, 'dir') ?? DEFAULT_UPLOAD_DIR
  const uploads = fileFields(parts, 'file')
  if (uploads.length === 0) {
    sendJson(res, 400, { ok: false, error: 'no file part' })
    return
  }
  const saved: Array<{ relative: string; bytes: number }> = []
  try {
    for (const upload of uploads) {
      const landed = await landUpload(project, dir, upload.filename ?? 'asset', upload.data)
      // The relative path only: nothing this route answers may carry a
      // workspace path, for the same reason the listings do not.
      saved.push({ relative: landed.relative, bytes: landed.bytes })
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 200, { ok: true, project, dir, saved })
}

/** One file as the library describes it. */export interface LibraryFile {
  /** Path relative to `.assets`, `/` separators. */
  readonly path: string
  /** File name including its extension. */
  readonly name: string
  /** Owning project: the first directory under `.assets`. */
  readonly project: string
  /** First directory below the project (`01_角色`, …), or `''` for a file filed directly in it. */
  readonly group: string
  /** Media kind derived from the extension, so an unindexed file is still classified. */
  readonly kind: MediaKind
  /** Bytes on disk. */
  readonly size: number
  /** Last modification time in ms. */
  readonly mtime: number
}

/** One project's rollup, for the library's project view. */
export interface LibraryProject {
  /** Directory name under `.assets`. */
  readonly name: string
  /** Files the walk found (bookkeeping aside). */
  readonly files: number
  /** Their total size. */
  readonly bytes: number
  /** Newest file's mtime, or 0 for a project with none. */
  readonly updatedAt: number
  /** Newest image, as a path to hand to the file route; undefined when it has none. */
  readonly cover: string | undefined
}

/**
 * Collect one directory's files, depth-first and bounded.
 *
 * The walk is bounded in both directions: a project nested deeper than
 * {@link MAX_LIBRARY_DEPTH} and a tree larger than {@link MAX_LIBRARY_FILES}
 * both stop the walk rather than making the answer unbounded.
 * @param dir - absolute directory to read.
 * @param project - owning project name.
 * @param prefix - `dir`'s path relative to `.assets`.
 * @param depth - remaining descent below `dir`.
 * @param out - the list being built.
 */
async function collectLibraryFiles(
  dir: string,
  project: string,
  prefix: string,
  depth: number,
  out: LibraryFile[],
): Promise<void> {
  if (depth < 0 || out.length >= MAX_LIBRARY_FILES) return
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirents) {
    if (out.length >= MAX_LIBRARY_FILES) return
    const relative = `${prefix}/${dirent.name}`
    if (dirent.isDirectory()) {
      await collectLibraryFiles(join(dir, dirent.name), project, relative, depth - 1, out)
      continue
    }
    if (BOOKKEEPING.has(dirent.name)) continue
    let info
    try {
      info = await stat(join(dir, dirent.name))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const below = relative.slice(project.length + 1)
    const separator = below.indexOf('/')
    out.push({
      path: relative,
      name: dirent.name,
      project,
      group: separator < 0 ? '' : below.slice(0, separator),
      kind: kindOf(extname(dirent.name).toLowerCase()),
      size: info.size,
      mtime: info.mtimeMs,
    })
  }
}

/**
 * Answer the whole tree in one listing.
 *
 * The canvas library browses projects, not directories: walking the tree once
 * here is what lets the page show every project with its cover and counts
 * without issuing a request per directory.
 * @param res - the response to write.
 */
async function serveLibrary(res: ServerResponse): Promise<void> {
  const root = assetsRoot()
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch {
    sendJson(res, 200, { ok: true, projects: [], files: [], truncated: false })
    return
  }
  const files: LibraryFile[] = []
  const projects: LibraryProject[] = []
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    if (!dirent.isDirectory()) continue
    const before = files.length
    await collectLibraryFiles(join(root, dirent.name), dirent.name, dirent.name, MAX_LIBRARY_DEPTH, files)
    const own = files.slice(before)
    let newest: LibraryFile | undefined
    let newestImage: LibraryFile | undefined
    let bytes = 0
    for (const file of own) {
      bytes += file.size
      if (newest === undefined || file.mtime > newest.mtime) newest = file
      if (file.kind === 'image' && (newestImage === undefined || file.mtime > newestImage.mtime)) newestImage = file
    }
    projects.push({
      name: dirent.name,
      files: own.length,
      bytes,
      updatedAt: newest?.mtime ?? 0,
      cover: newestImage?.path,
    })
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt)
  files.sort((a, b) => b.mtime - a.mtime)
  sendJson(res, 200, { ok: true, projects, files, truncated: files.length >= MAX_LIBRARY_FILES })
}

/** Stream one file of the asset tree, honouring a single byte range. */async function serveFile(req: IncomingMessage, res: ServerResponse, requested: string): Promise<void> {
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
  const path = url.pathname.slice(ASSETS_ROUTE_PREFIX.length) || '/'
  const requested = url.searchParams.get('path') ?? ''
  if (path === UPLOAD_PATH) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'upload takes POST' })
      return
    }
    await serveUpload(req, res)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (path === TREE_PATH) {
    await serveTree(res, requested)
    return
  }
  if (path === BLUEPRINTS_PATH) {
    await serveBlueprints(res)
    return
  }
  if (path === LIBRARY_PATH) {
    await serveLibrary(res)
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
