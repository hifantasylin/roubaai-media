/**
 * Routes over the asset trees: the session's workspace, plus mounted libraries.
 *
 * The canvas workbench is a browser app: it can display a URL, not a path. These
 * routes are what turn the asset trees into URLs — list a directory, list the
 * whole library, serve a file, accept an upload — so a canvas node can show an
 * image or a video straight out of `.assets` instead of importing a second copy
 * into browser storage, and the canvas' asset library can browse projects
 * without walking the filesystem from the browser.
 *
 * A request names the session it belongs to and the tree it addresses; the
 * session's workspace is resolved host-side (a caller-supplied path would make
 * these routes an arbitrary-file reader), and only the primary tree — the one
 * belonging to that workspace — accepts writes.
 *
 * Nothing outside a tree is reachable: every request path is resolved against
 * the named root and refused when it leaves that directory, so `..`, an absolute
 * path or a drive letter never reaches the filesystem. The listings answer with
 * relative paths only — an absolute path is the one thing the canvas
 * deliberately keeps out of anything it sends to a model, and these routes have
 * no reason to hand one out.
 *
 * @module @roubaai/media/asset-routes
 */

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { landMediaAsset, type LandedAsset } from './asset-landing.ts'
import { resolveInRoot, rootById, rootsForWorkspace, type AssetRoot, type AssetRoots } from './asset-root.ts'
import { fileFields, parseMultipart, textField } from './multipart.ts'

// The root resolver lives in one module so the routes, the tools and the landing
// path cannot drift apart.
export { primaryAssetsRoot, resolveInRoot, rootById, rootsForWorkspace } from './asset-root.ts'
export type { AssetRoot, AssetRoots } from './asset-root.ts'

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

/** Query parameter naming the session a request belongs to. */
const SESSION_PARAM = 'session'
/** Query parameter naming the tree a request addresses. */
const ROOT_PARAM = 'root'

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

/**
 * Resolve the workspace a request belongs to.
 *
 * Supplied by the composition, which owns the session lookup: a route that took
 * the path from its caller would read any file the host can read.
 * @param sessionId - the session the request named, when it named one.
 * @returns the session's working directory, or undefined when it is unknown.
 */
export type WorkspaceResolver = (sessionId: string | undefined) => Promise<string | undefined> | string | undefined

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

/** List one directory of one tree. */
async function serveTree(res: ServerResponse, root: AssetRoot, requested: string): Promise<void> {
  const target = resolveInRoot(root.path, requested)
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
    if (dirent.name.startsWith('.')) continue
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
    root: root.id,
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
 * host produced for the work at hand. Blueprints belong to the work in the
 * current workspace, so only the primary tree is read.
 * @param res - the response to write.
 * @param root - the workspace's own tree.
 */
async function serveBlueprints(res: ServerResponse, root: AssetRoot): Promise<void> {
  let dirents
  try {
    dirents = await readdir(root.path, { withFileTypes: true })
  } catch {
    sendJson(res, 200, { ok: true, blueprints: [] })
    return
  }
  const blueprints: Array<{ project: string; mtime: number; bytes: number }> = []
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    if (!dirent.isDirectory()) continue
    const file = join(root.path, dirent.name, BLUEPRINT_FILE)
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
 * Land one uploaded file into a project of the writable tree.
 *
 * The write goes through `asset-landing`, so an upload lands exactly where a
 * generated file lands: same path rules, same category vocabulary, same index
 * row. That is the whole point — an asset added by hand and one produced by a
 * run must be the same kind of thing.
 * @param root - the writable tree.
 * @param project - project folder under the tree.
 * @param dir - sub-directory to file into.
 * @param filename - the uploaded name, whose extension is kept.
 * @param bytes - the file bytes.
 * @returns where it landed.
 */
async function landUpload(root: AssetRoot, project: string, dir: string, filename: string, bytes: Buffer): Promise<LandedAsset> {
  const ext = extname(filename).replace(/^\./, '').toLowerCase() || 'bin'
  const name = filename.slice(0, filename.length - extname(filename).length) || 'asset'
  return await landMediaAsset({
    assetsRoot: root.path,
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
 * Accept an upload into the writable tree.
 *
 * The body is `multipart/form-data` with a `project` field, an optional `dir`
 * field, and one or more `file` parts. Refusals are the landing module's own:
 * a project or directory that escapes the tree is rejected rather than
 * sanitized. A mount refuses outright — adding to a shared library is an
 * explicit act (import into this project), not a side effect of an upload.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param root - the tree the request named.
 */
async function serveUpload(req: IncomingMessage, res: ServerResponse, root: AssetRoot): Promise<void> {
  if (!root.writable) {
    sendJson(res, 403, { ok: false, error: 'this library is read-only; import the file into the current project instead' })
    return
  }
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
      const landed = await landUpload(root, project, dir, upload.filename ?? 'asset', upload.data)
      // The relative path only: nothing this route answers may carry a
      // filesystem path, for the same reason the listings do not.
      saved.push({ relative: landed.relative, bytes: landed.bytes })
    }
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 200, { ok: true, root: root.id, project, dir, saved })
}

/** One file as the library describes it. */
export interface LibraryFile {
  /** Tree the file belongs to. */
  readonly root: string
  /** Path relative to that tree, `/` separators. */
  readonly path: string
  /** File name including its extension. */
  readonly name: string
  /** Owning project: the first directory under the tree. */
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
  /** Tree the project belongs to. */
  readonly root: string
  /** Directory name under the tree. */
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
 * @param root - the tree's id (stamped onto every file).
 * @param dir - absolute directory to read.
 * @param project - owning project name.
 * @param prefix - `dir`'s path relative to the tree.
 * @param depth - remaining descent below `dir`.
 * @param out - the list being built.
 */
async function collectLibraryFiles(
  root: string,
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
    // A hidden entry is bookkeeping or transport (`.roubaai-refs`), not an asset.
    if (dirent.name.startsWith('.')) continue
    const relative = `${prefix}/${dirent.name}`
    if (dirent.isDirectory()) {
      await collectLibraryFiles(root, join(dir, dirent.name), project, relative, depth - 1, out)
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
      root,
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
 * Answer every tree in one listing.
 *
 * The canvas library browses projects, not directories: walking the trees once
 * here is what lets the page show every project with its cover and counts
 * without issuing a request per directory. Each item is stamped with its root,
 * so the client can address the file route back to the right tree.
 * @param res - the response to write.
 * @param roots - the roots this request resolves against.
 */
async function serveLibrary(res: ServerResponse, roots: AssetRoots): Promise<void> {
  const files: LibraryFile[] = []
  const projects: LibraryProject[] = []
  for (const root of [roots.primary, ...roots.mounts]) {
    let dirents
    try {
      dirents = await readdir(root.path, { withFileTypes: true })
    } catch {
      // A tree that does not exist yet is an empty library, not an error.
      continue
    }
    for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
      const before = files.length
      await collectLibraryFiles(root.id, join(root.path, dirent.name), dirent.name, dirent.name, MAX_LIBRARY_DEPTH, files)
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
        root: root.id,
        name: dirent.name,
        files: own.length,
        bytes,
        updatedAt: newest?.mtime ?? 0,
        cover: newestImage?.path,
      })
    }
  }
  // The writable tree first, then every tree by its newest project.
  const rank = (project: LibraryProject): number => (project.root === roots.primary.id ? 0 : 1)
  projects.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
  files.sort((a, b) => b.mtime - a.mtime)
  sendJson(res, 200, {
    ok: true,
    roots: [roots.primary, ...roots.mounts].map(root => ({ id: root.id, writable: root.writable })),
    projects,
    files,
    truncated: files.length >= MAX_LIBRARY_FILES,
  })
}

/** Stream one file of one tree, honouring a single byte range. */
async function serveFile(req: IncomingMessage, res: ServerResponse, root: AssetRoot, requested: string): Promise<void> {
  const target = resolveInRoot(root.path, requested)
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
 * Answer one asset request.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param url - the parsed request URL.
 * @param resolveWorkspace - how this host turns a session id into a workspace.
 */
export async function handleAssetsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  resolveWorkspace: WorkspaceResolver = () => undefined,
): Promise<void> {
  const path = url.pathname.slice(ASSETS_ROUTE_PREFIX.length) || '/'
  const requested = url.searchParams.get('path') ?? ''
  const sessionId = url.searchParams.get(SESSION_PARAM) ?? undefined
  const roots = rootsForWorkspace(sessionId === undefined ? undefined : await resolveWorkspace(sessionId))
  const named = rootById(roots, url.searchParams.get(ROOT_PARAM) ?? undefined)
  if (named === undefined) {
    // An unknown id is a client bug; reading a different tree instead would be
    // the kind of silent substitution that makes a library untrustworthy.
    sendJson(res, 400, { ok: false, error: `unknown asset root "${url.searchParams.get(ROOT_PARAM) ?? ''}"` })
    return
  }
  if (path === UPLOAD_PATH) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'upload takes POST' })
      return
    }
    await serveUpload(req, res, named)
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (path === TREE_PATH) {
    await serveTree(res, named, requested)
    return
  }
  if (path === BLUEPRINTS_PATH) {
    await serveBlueprints(res, roots.primary)
    return
  }
  if (path === LIBRARY_PATH) {
    await serveLibrary(res, roots)
    return
  }
  if (path === FILE_PATH) {
    await serveFile(req, res, named, requested)
    return
  }
  sendJson(res, 404, { ok: false, error: `unknown asset path ${path}` })
}

/**
 * Register the asset routes on the host webserver.
 *
 * The workspace resolver reads the session service, so the session id a browser
 * sends is turned into a path by the host rather than trusted from the wire.
 * @param ctx - the plugin context.
 * @returns the disposer removing the routes.
 */
/**
 * The host's session-to-workspace lookup.
 *
 * The session service is read through `ctx.get` rather than injected: a host
 * without sessions (a stripped deployment, a unit test) still serves the mounted
 * library, it just cannot resolve a workspace.
 * @param ctx - the plugin context.
 * @returns the resolver the routes and the facade share.
 */
export function workspaceOfSession(ctx: Context, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || sessionId === '') return undefined
  const sessions = ctx.get('sessions') as { get(id: string): { header?: { cwd?: string } } | undefined } | undefined
  return sessions?.get(sessionId)?.header?.cwd
}

/**
 * The routes' form of {@link workspaceOfSession}.
 * @param ctx - the plugin context.
 * @returns the resolver the routes use.
 */
export function sessionWorkspaceResolver(ctx: Context): WorkspaceResolver {
  return (sessionId) => workspaceOfSession(ctx, sessionId)
}

/**
 * Register the asset routes on the host webserver.
 *
 * The workspace resolver reads the session service, so the session id a browser
 * sends is turned into a path by the host rather than trusted from the wire.
 * @param ctx - the plugin context.
 * @returns the disposer removing the routes.
 */
export function registerAssetRoutes(ctx: Context): () => void {
  const resolver = sessionWorkspaceResolver(ctx)
  return ctx.webServer.register({
    kind: 'prefix',
    path: ASSETS_ROUTE_PREFIX,
    handler: (req, res): void => {
      void handleAssetsRequest(req, res, new URL(req.url ?? ASSETS_ROUTE_PREFIX, 'http://dsh.internal'), resolver)
    },
  })
}
