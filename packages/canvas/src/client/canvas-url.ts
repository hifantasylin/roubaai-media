/**
 * The URL the sidebar panel shows, and the mount point it is resolved against.
 *
 * The panel is one sidebar tab, not one tab per project: the canvas is a single
 * app whose own routing carries the project (`?bp=`), so the tab's content is a
 * URL this module owns. Links and the tab read the same store, which is why one
 * source of truth is enough — no tab seed, no per-open identity.
 *
 * The panel also names the session it was opened for (`ds`), because the host
 * resolves a request's workspace host-side from the session id: a browser that
 * sent a path would be asking the host to read whatever it named.
 *
 * The mount point is deployment configuration (`basePath` in the composition),
 * so it comes from the host half's panel route rather than being duplicated
 * here; {@link FALLBACK_BASE_PATH} covers the first paint and a host that does
 * not answer.
 * @module @roubaai/canvas/client/canvas-url
 */

/** Where the host half publishes the resolved mount point. */
export const PANEL_INFO_ROUTE = '/api/roubaai-canvas/panel'

/** Painted until the host half answers, and when it cannot be reached. */
export const FALLBACK_BASE_PATH = '/canvas'

/**
 * Normalize a mount point into `/<name>` with no trailing slash.
 * @param value - the configured mount point.
 * @returns the normalized mount point, or the fallback when the input is empty.
 */
export function normalizeBasePath(value: string): string {
  const raw = value.trim()
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`
  return withLeading.replace(/\/+$/, '') || FALLBACK_BASE_PATH
}

/** Resolved mount point; replaced once the host half answers. */
let basePath = FALLBACK_BASE_PATH

/** The canvas location a link asked for, or undefined for the mount root. */
let requested: string | undefined

/** The URL currently rendered, kept referentially stable between changes. */
let shown = `${FALLBACK_BASE_PATH}/`

const listeners = new Set<() => void>()

/** Recompute the shown URL and notify only when it actually moved. */
function refresh(): void {
  const next = requested ?? `${basePath}/`
  if (next === shown) return
  shown = next
  for (const listener of listeners) listener()
}

/**
 * Subscribe to the shown URL.
 * @param listener - called after each change.
 * @returns the unsubscriber.
 */
export function subscribeCanvasUrl(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * The URL the panel shows, stable between changes (the store shape React's
 * `useSyncExternalStore` requires).
 * @returns the canvas URL, relative to this origin.
 */
export function canvasUrlSnapshot(): string {
  return shown
}

/** The mount point as last resolved; a link is matched against it at click time. */
export function canvasBasePath(): string {
  return basePath
}

/**
 * Show one canvas location in the panel.
 * @param target - a path with its query, or undefined for the mount root.
 */
export function showCanvas(target?: string): void {
  requested = target === undefined || target === '' ? undefined : target
  refresh()
}

/**
 * Add the session marker to a canvas URL.
 *
 * The canvas reads it from its own query string and passes it back on every host
 * request, which is how the host knows which workspace the request belongs to.
 * @param url - the canvas URL (path, query and fragment).
 * @param sessionId - the session the panel was opened for.
 * @returns the URL with `ds` set.
 */
export function withHostSession(url: string, sessionId: string): string {
  if (sessionId === '') return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}ds=${encodeURIComponent(sessionId)}`
}

/**
 * Read the mount point from the host half. Idempotent: the value is fixed per
 * deployment, so a second call only repeats the assignment.
 * @returns after the mount point is resolved, or after the read failed.
 */
export async function resolveCanvasBasePath(): Promise<void> {
  try {
    const response = await fetch(PANEL_INFO_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return
    const body = await response.json() as { basePath?: unknown }
    if (typeof body.basePath !== 'string' || body.basePath === '') return
    basePath = normalizeBasePath(body.basePath)
    refresh()
  } catch {
    // A host that serves no panel route is a deployment this half cannot repair
    // from the browser; the default mount point stands and the iframe shows the
    // host's own explanation page.
  }
}
