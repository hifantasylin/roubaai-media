/**
 * Client half of `@roubaai/canvas`: the canvas as a right-sidebar tab.
 *
 * The shell's right column belongs to the sidebar plugin, which exposes a
 * registration service for exactly this: a tab type of our own, listed in its
 * "new tab" menu and openable by any code that holds the service. The canvas
 * therefore reaches the user two ways, and both land in the same tab:
 *
 * - the menu entry, for when the user goes looking;
 * - a canvas link in the conversation, which this half takes over and turns
 *   into that same open, so the workbench opens beside the chat instead of in
 *   a browser window.
 *
 * Registering the type and taking over the clicks are one decision split in
 * two: both name {@link TAB_ID}, and a link that opened something else would be
 * a defect no other check would catch.
 *
 * The canvas itself stays a served app under the host's mount point; this half
 * owns only the panel around it. `inject` waits for the sidebar service, so a
 * deployment without that plugin simply has no in-app canvas surface — the
 * route under the mount point is unaffected.
 * @module @roubaai/canvas/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the sidebar service's Context merge (ctx.betterSidebar).
import type {} from 'dsh-better-sidebar/client/service'
import { CanvasPanel } from './canvas-panel.tsx'
import { CanvasPanelIcon } from './canvas-panel-icon.tsx'
import { resolveCanvasBasePath, showCanvas } from './canvas-url.ts'
import { registerCanvasLinkTakeover } from './link-takeover.ts'

/** The sidebar service must be up before a tab can be contributed. */
export const inject = ['betterSidebar']

/** The tab type's id; the sidebar keys registration, menu rows, and opens on it. */
const TAB_ID = 'roubaai:canvas'

/**
 * The tab's title. The shell localizes its own chrome, not this package's copy,
 * so the panel names itself.
 * @returns the title in the active shell locale.
 */
function title(): string {
  return '画布'
}

/** Immediately after the built-in browser tab. */
const TAB_ORDER = 60

/**
 * Register the canvas tab and take over canvas links.
 * @param ctx - the client cordis context carrying the sidebar service.
 */
export function apply(ctx: Context): void {
  // Started here, not on first render: a link can be clicked before the panel
  // has ever been opened, and matching it needs the resolved mount point.
  void resolveCanvasBasePath()

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_ID,
    title,
    icon: size => <CanvasPanelIcon size={size} />,
    order: TAB_ORDER,
    // One canvas: an open from a link reveals the panel already showing it
    // rather than stacking a second copy of the same app.
    single: true,
    // The session scope is the tab's own: it is what tells the canvas which
    // workspace its asset and generation requests belong to, without the
    // browser ever naming a path.
    component: ({ scope }) => <CanvasPanel sessionId={scope.sessionId} />,
  }), 'roubaai-canvas: sidebar tab')

  ctx.effect(() => registerCanvasLinkTakeover((target) => {
    // The store first: the tab reads it on mount, and on a second link the
    // update re-renders the panel that is already open.
    showCanvas(target)
    ctx.betterSidebar.openTab({ type: TAB_ID, title: title() })
  }), 'roubaai-canvas: canvas link takeover')
}
