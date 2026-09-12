/**
 * Click policy for canvas links in the shell: a link pointing at the canvas
 * opens it in the right sidebar instead of a browser window.
 *
 * The shell offers two browser destinations for an http link, and neither is
 * what a canvas link wants: the OS browser (an absolute link is opened outside
 * the app) and the sidebar's own browser panel, which embeds pages in an opaque
 * origin — the canvas would load there but every generation call would arrive
 * as a foreign origin and be refused. Taking the click over and opening our own
 * sidebar tab keeps the canvas same-origin, so it behaves exactly as it does
 * when the route is visited directly.
 *
 * The sidebar plugin that owns external links deliberately ignores same-origin
 * links (it treats them as shell navigation), so this half claims exactly the
 * case that plugin declines, and both can coexist without ordering rules.
 * @module @roubaai/canvas/client/link-takeover
 */

import { canvasBasePath } from './canvas-url.ts'

/** A loopback hostname (localhost, ::1, 127.0.0.0/8, 0.0.0.0). */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  const parts = host.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** How one href is judged against this deployment. */
export interface CanvasLinkContext {
  /** Resolved mount point, e.g. `/canvas`. */
  readonly basePath: string
  /** The shell's own origin; a link to it is shell navigation, not a foreign site. */
  readonly selfOrigin: string
  /** The document URL a relative href resolves against. */
  readonly baseHref: string
}

/**
 * The canvas location an href names.
 *
 * Accepted: any http(s) URL whose path is the mount point or below it, on this
 * origin or on a loopback host — a link written for another local port still
 * names this canvas, and the panel resolves it against the mount point it was
 * configured with. Everything else is somebody else's link.
 * @param href - the anchor's href, as authored.
 * @param context - the mount point, origin, and resolution base.
 * @returns the location to show (path, query, fragment), or undefined when the link is not ours.
 */
export function canvasLinkTarget(
  href: string | null | undefined,
  context: CanvasLinkContext,
): string | undefined {
  if (href === undefined || href === null || href === '') return undefined
  let url: URL
  try {
    url = new URL(href, context.baseHref)
  } catch {
    // An unparsable href is not a link we can classify.
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.pathname !== context.basePath && !url.pathname.startsWith(`${context.basePath}/`)) return undefined
  if (url.origin !== context.selfOrigin && !isLoopbackHostname(url.hostname)) return undefined
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * The part of a click event this policy reads. Structural so the policy is
 * unit-testable without a DOM.
 */
export interface CanvasClickLike {
  readonly button: number
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly defaultPrevented: boolean
  readonly target: { closest(selector: string): { getAttribute(name: string): string | null } | null } | null
  preventDefault(): void
}

/** Whether a plain, unmodified left click may be taken over. */
function isPlainLeftClick(event: CanvasClickLike): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/**
 * Decide one click.
 * @param event - the click, structurally.
 * @param context - the mount point, origin, and resolution base.
 * @returns the canvas location to open, or undefined to let the click through.
 */
export function canvasClickTarget(event: CanvasClickLike, context: CanvasLinkContext): string | undefined {
  if (!isPlainLeftClick(event) || event.defaultPrevented) return undefined
  const anchor = event.target === null ? null : event.target.closest('a[href]')
  if (anchor === null) return undefined
  return canvasLinkTarget(anchor.getAttribute('href'), context)
}

/** The document surface the takeover installs on. */
export interface CanvasLinkHost {
  /** The shell's own origin. */
  readonly selfOrigin: string
  /** The document URL a relative href resolves against. */
  readonly baseHref: string
}

/**
 * Take over canvas link clicks in the shell document.
 * @param open - receives the canvas location to show; the caller opens the panel.
 * @param host - the document's origin and URL; defaults to the live document.
 * @returns the disposer removing the listener.
 */
export function registerCanvasLinkTakeover(
  open: (target: string) => void,
  host?: CanvasLinkHost,
): () => void {
  const context: CanvasLinkHost = host ?? { selfOrigin: location.origin, baseHref: location.href }
  const onClick = (event: MouseEvent): void => {
    const target = canvasClickTarget(event as unknown as CanvasClickLike, {
      ...context,
      basePath: canvasBasePath(),
    })
    if (target === undefined) return
    event.preventDefault()
    open(target)
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}
