/**
 * Local reference-media URL normalizer (`ctx.mediaUrl`).
 *
 * The `generate_image` / `generate_video` providers only accept a reachable
 * public https URL for reference images (`refImages` / `imageUrls`); local
 * file paths and base64 are rejected upstream. This service turns a local
 * reference image path into a public URL on demand by running a tiny static
 * file server over the video project directory and a Cloudflare quick tunnel
 * in front of it, then caching the tunnel base URL for the lifetime of the
 * media fiber.
 *
 * Lifecycle: lazily started on the first local reference it sees (so an
 * install that never passes local references never spawns a server or
 * tunnel), and torn down when the owning `ctx` fiber disposes.
 *
 * @module @roubaai/media/tunnel
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, normalize, join, relative } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { stagingRoot } from './asset-root.ts'

/** Local static-server port in front of the tunnel. */
const STATIC_PORT = Number(process.env.DSH_MEDIA_STATIC_PORT ?? 8765)
/** DSH host base URL used to resolve host-local `/...` reference routes. */
const HOST_BASE = (process.env.DSH_MEDIA_HOST ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
/**
 * The DSH home. Read from the environment because a profile can live outside
 * the OS user's home directory; `homedir()` only covers a host that does not
 * set it. Never spell the user name out: it differs on every machine, and a
 * baked-in one silently breaks every install but the author's.
 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** Path to the cloudflared binary shipped with the remote web gateway plugin. */
const CLOUDFLARED_BIN =
  process.env.DSH_MEDIA_CLOUDFLARED_BIN
  ?? join(DSH_HOME, 'plugins', 'dsh-remote-web-gateway', 'bin', 'cache', 'cloudflared.exe')

/** MIME map served by the static server (extended with common media types). */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

/** True when `value` is a public https URL the provider can reach directly. */
function isPublicUrl(value: string): boolean {
  return /^https:\/\//i.test(value)
}

/** True when `value` is a host-local http URL or a `/...` route the provider cannot reach. */
function isHostLocalUrl(value: string): boolean {
  // `/api/...`, `/describe-image/raw/...`, any server-relative route
  if (value.startsWith('/')) return true
  // `http://127.0.0.1:...` / `http://localhost:...` (but not public http, rare)
  return /^http:\/\/(127\.0\.0\.1|localhost|::1)(:\d+)?/i.test(value)
}

/** True when `value` looks like a local path (Windows drive / file URL / bare path). */
function isLocalPath(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true // C:\... or C:/...
  if (value.startsWith('file://')) return true
  return false
}

/**
 * The local reference normalizer service. Registered as `ctx.mediaUrl` for
 * the lifetime of the media apply fiber; started lazily and disposed with it.
 */
export class MediaUrlNormalizer extends Service {
  private server: Server | undefined
  private tunnel: ChildProcess | undefined
  private baseUrl: string | undefined
  private starting: Promise<string> | undefined
  /** The fixed workspace root that `/_local/...` serves files from. */
  private root: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'mediaUrl')
    // Binds teardown to the apply fiber: the tunnel and server are killed when
    // the media plugin is withdrawn.
    this.ctx.effect(function* (this: MediaUrlNormalizer) {
      yield () => {
        this.teardown()
      }
    }.bind(this), 'media.mediaUrl')
  }

  /** Normalize a single reference value into a public https URL the provider can reach. */
  async normalize(ref: string, workspaceRoot?: string): Promise<string> {
    if (isPublicUrl(ref)) return ref
    if (isHostLocalUrl(ref)) {
      // Host-local route (`/describe-image/raw/...`, `/api/...`, `127.0.0.1`):
      // resolve to an absolute URL and proxy it through the tunnel so the
      // provider can fetch it.
      const absolute = ref.startsWith('/') ? `${HOST_BASE}${ref}` : ref
      const base = await this.ensureStarted()
      return `${base}/_proxy/${encodeURIComponent(absolute)}`
    }
    if (isLocalPath(ref)) {
      // Local file path: serve it from the fixed staging root through the
      // tunnel's static file route. The root is set server-side (first startup)
      // and never taken from the URL, so the public tunnel can only read files
      // under the directory the asset library lives in.
      const base = await this.ensureStarted(workspaceRoot)
      const root = this.root ?? stagingRoot(workspaceRoot)
      return `${base}/_local/${this.toPublicPath(ref, root)}`
    }
    return ref
  }

  /** Normalize an array of reference values in place. */
  async normalizeAll(refs: readonly string[], workspaceRoot?: string): Promise<string[]> {
    return Promise.all(refs.map(ref => this.normalize(ref, workspaceRoot)))
  }

  /**
   * Lazily start the static server + tunnel and return the cached tunnel
   * base URL. Concurrent callers share a single startup promise. The first
   * call pins the root that `/_local/...` serves from.
   */
  private ensureStarted(workspaceRoot?: string): Promise<string> {
    if (this.baseUrl !== undefined) return Promise.resolve(this.baseUrl)
    if (this.starting !== undefined) return this.starting
    this.root = stagingRoot(workspaceRoot)
    this.starting = this.start()
    return this.starting
  }

  private async start(): Promise<string> {
    await this.ensureServer()
    const url = await this.startTunnel()
    this.baseUrl = url
    return url
  }

  private async ensureServer(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((req, res) => {
      void this.serve(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(STATIC_PORT, '127.0.0.1', () => resolve())
    })
    this.server = server
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const pathname = url.pathname
      // Proxy route: /_proxy/<encodeURIComponent(target)>
      if (pathname.startsWith('/_proxy/')) {
        const target = decodeURIComponent(pathname.slice('/_proxy/'.length))
        const upstream = await fetch(target, { signal: AbortSignal.timeout(60_000) })
        const body = Buffer.from(await upstream.arrayBuffer())
        const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
        res.writeHead(upstream.status, { 'Content-Type': contentType, 'Content-Length': body.length })
        res.end(body)
        return
      }
      // Local file route: /_local/<relative path>, served only from the fixed
      // workspace root (set server-side at first startup). The public tunnel
      // can never read outside this root.
      if (pathname.startsWith('/_local/') && this.root !== undefined) {
        const rel = decodeURIComponent(pathname.slice('/_local/'.length))
        const filePath = normalize(join(this.root, rel))
        if (!filePath.startsWith(normalize(this.root))) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden')
          return
        }
        const data = await readFile(filePath)
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' }).end(data)
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found')
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found')
    }
  }

  /** Spawn cloudflared and wait for the printed tunnel URL. */
  private startTunnel(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!existsSync(CLOUDFLARED_BIN)) {
        reject(new Error(`mediaUrl: cloudflared binary not found at ${CLOUDFLARED_BIN}`))
        return
      }
      const tunnel = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://127.0.0.1:${STATIC_PORT}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        tunnel.kill()
        reject(new Error('mediaUrl: cloudflared tunnel timed out starting'))
      }, 30_000)
      let stderr = ''
      tunnel.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        const match = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i.exec(stderr)
        const baseUrl = match?.[1]
        if (baseUrl !== undefined) {
          clearTimeout(timer)
          this.tunnel = tunnel
          resolve(baseUrl)
        }
      })
      tunnel.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      tunnel.once('exit', (code) => {
        if (this.tunnel !== tunnel) {
          clearTimeout(timer)
          reject(new Error(`mediaUrl: cloudflared exited early (code ${String(code)})`))
        }
      })
    })
  }

  /** Map a local path to the static server's public URL path, relative to the workspace root. */
  private toPublicPath(ref: string, root: string): string {
    let normalized = ref
    if (normalized.startsWith('file://')) {
      try {
        normalized = decodeURIComponent(new URL(normalized).pathname)
      } catch {
        normalized = normalized.replace(/^file:\/\//, '')
      }
    }
    // If the ref is absolute and under root, compute the path relative to root
    // (so `/_local/<rel>` joins back to the right file under the workspace).
    if (isAbsolute(normalized)) {
      const rel = relative(root, normalized)
      // Guard: if outside the root (relative() returns ../...), reject it.
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return rel.replace(/\\/g, '/')
      }
      // Fallback: strip the drive letter (path outside the workspace root).
      normalized = normalized.replace(/^[a-zA-Z]:/, '')
    }
    return normalized.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  private teardown(): void {
    if (this.tunnel !== undefined) {
      try { this.tunnel.kill() } catch { /* already dead */ }
      this.tunnel = undefined
    }
    if (this.server !== undefined) {
      try { this.server.close() } catch { /* already closed */ }
      this.server = undefined
    }
    this.baseUrl = undefined
    this.starting = undefined
  }
}

export default MediaUrlNormalizer
