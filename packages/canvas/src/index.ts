/**
 * `@roubaai/canvas` — the canvas workbench's host half.
 *
 * The canvas is a browser app; making it useful from the harness means serving it
 * from the harness origin, so its pages can call the media routes as same-origin
 * requests. This plugin does exactly that and nothing else: no DOM patching, no
 * second process, no injected sidebar entry.
 *
 * What it serves, all under `basePath` (default `/canvas`):
 * - the built frontend from `canvasRoot`, with an SPA fallback to `index.html`;
 * - `/plugins/index.json` — the local node-plugin manifest the canvas discovers
 *   on startup — listing the asset-library node this package ships;
 * - `/plugins/roubaai-assets.js` — that node plugin.
 *
 * `canvasRoot` must be a build made with a matching `VITE_BASE` (the frontend
 * references its bundle as `/assets/...`, so a build for `/` cannot be served
 * under `/canvas/`). With no `canvasRoot` configured the route answers a plain
 * explanation instead of pretending to be an app.
 *
 * @module @roubaai/canvas
 */

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'roubaai-canvas'

/** The webserver service must be up before the routes can mount. */
export const inject = ['webServer']

/** Default mount point; a build for another prefix sets `basePath` to match. */
const DEFAULT_BASE_PATH = '/canvas'

/**
 * The package root, found by walking up to the nearest `package.json`.
 *
 * The same code runs from `src/` under the test runner and from `lib/types/`
 * once built, so the package root cannot be a fixed number of `..` hops.
 * @param start - the directory to search from.
 * @returns the nearest directory holding a `package.json`, else the start.
 */
function findPackageRoot(start: string): string {
  let directory = start
  for (let hop = 0; hop < 5; hop += 1) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return start
}

/** Where this package's own files live (the shipped node plugin). */
const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)))

/** Configuration the composition supplies for this plugin. */
export interface CanvasConfig {
  /** Built frontend directory (`VITE_BASE` must match {@link CanvasConfig.basePath}). */
  readonly canvasRoot?: string
  /** Mount point; defaults to `/canvas`. */
  readonly basePath?: string
}

/** Normalize a mount point into `/<name>` with no trailing slash. */
function normalizeBasePath(value: string | undefined): string {
  const raw = (value ?? DEFAULT_BASE_PATH).trim()
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.replace(/\/+$/, '') || DEFAULT_BASE_PATH
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(payload.length) })
  res.end(payload)
}

/** The instruction a deployment sees when the frontend artifact is missing. */
function missingRootMessage(basePath: string): string {
  return [
    `@roubaai/canvas: no canvasRoot is configured, so there is no frontend to serve at ${basePath}/.`,
    '',
    'Build the workbench with a matching base path and point canvasRoot at it:',
    '  cd <infinite-canvas>/web',
    `  VITE_BASE=${basePath}/ bun install && VITE_BASE=${basePath}/ bun run build`,
    '',
    'then set the router row:',
    '  - id: roubaai-canvas',
    "    name: '@roubaai/canvas'",
    '    config:',
    `      basePath: ${basePath}`,
    '      canvasRoot: <absolute path to .../web/dist>',
    '',
  ].join('\n')
}

/**
 * Resolve a request path inside the frontend directory.
 * @param root - the built frontend directory.
 * @param relative - the request path below the mount point.
 * @returns the absolute file path, or undefined when it escapes the root.
 */
export function resolveCanvasFile(root: string, relative: string): string | undefined {
  if (relative.includes('\0')) return undefined
  const cleaned = relative.replace(/^\/+/, '')
  const target = resolve(root, cleaned)
  const prefix = root.endsWith(sep) ? root : root + sep
  return target === root || target.startsWith(prefix) ? target : undefined
}

/**
 * Answer one canvas request.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param url - the parsed request URL.
 * @param config - the resolved configuration.
 */
export async function handleCanvasRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: { basePath: string; canvasRoot: string },
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
    return
  }
  const { basePath, canvasRoot } = config

  // The mount point without its trailing slash is not a file: send the browser
  // to the directory form so relative URLs in index.html resolve.
  if (url.pathname === basePath) {
    res.writeHead(302, { location: `${basePath}/` })
    res.end()
    return
  }
  const relative = url.pathname.slice(basePath.length).replace(/^\/+/, '')

  // The plugin manifest and the shipped node plugin come from this package, not
  // from the frontend build: they are what makes a freshly built canvas aware of
  // the asset library.
  if (relative === 'plugins/index.json') {
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify([`${basePath}/plugins/roubaai-assets.js`]))
    return
  }
  if (relative === 'plugins/roubaai-assets.js') {
    try {
      const source = await readFile(join(packageRoot, 'assets', 'roubaai-assets-plugin.js'))
      send(res, 200, 'text/javascript; charset=utf-8', source)
    } catch {
      send(res, 404, 'text/plain; charset=utf-8', 'the bundled node plugin is missing from this install')
    }
    return
  }

  if (canvasRoot === '') {
    send(res, 503, 'text/plain; charset=utf-8', missingRootMessage(basePath))
    return
  }

  const target = resolveCanvasFile(canvasRoot, relative)
  if (target !== undefined && relative !== '') {
    try {
      const info = await stat(target)
      if (info.isFile()) {
        send(res, 200, MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', await readFile(target))
        return
      }
    } catch {
      // fall through to the SPA fallback
    }
  }
  try {
    send(res, 200, 'text/html; charset=utf-8', await readFile(join(canvasRoot, 'index.html')))
  } catch {
    send(res, 503, 'text/plain; charset=utf-8', missingRootMessage(basePath))
  }
}

/**
 * Register the canvas routes on the host webserver.
 * @param ctx - the plugin context.
 * @param config - the composition's configuration for this plugin.
 */
export function apply(ctx: Context, config: CanvasConfig = {}): void {
  const basePath = normalizeBasePath(config.basePath)
  const canvasRoot = resolve(config.canvasRoot ?? '')
  if (canvasRoot === '') {
    ctx.logger.warn(`roubaai-canvas: canvasRoot is unset; ${basePath}/ will explain how to build the frontend`)
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: basePath,
    handler: (req, res): void => {
      void handleCanvasRequest(req, res, new URL(req.url ?? basePath, 'http://dsh.internal'), { basePath, canvasRoot })
    },
  }), 'roubaai-canvas: canvas app routes')
}

export default { name, inject, apply }
