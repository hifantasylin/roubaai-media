/**
 * The canvas panel: the whole workbench in a same-origin iframe.
 *
 * An iframe and not a new window, because the canvas calls the generation
 * facade as a same-origin request — that is what keeps the provider key in the
 * host. A plain iframe (no `sandbox`) is deliberate: the sidebar's own browser
 * tab embeds pages in an opaque origin, which would turn every generation call
 * into a foreign-origin request the facade refuses.
 *
 * The height contract is the one the sidebar documents for the tabs it hosts:
 * the pane body has a definite height but is not a flex container, so the root
 * states `height: 100%` itself.
 * @module @roubaai/canvas/client/canvas-panel
 */

import { useSyncExternalStore, type JSX } from 'react'
import { canvasUrlSnapshot, subscribeCanvasUrl } from './canvas-url.ts'

/** The pane body has a definite height; the root states its own 100%. */
const ROOT_STYLE = { height: '100%', minHeight: 0 } as const

/** The frame fills the root; the canvas owns its own chrome and scrolling. */
const FRAME_STYLE = {
  width: '100%', height: '100%', border: 0, display: 'block',
} as const

/**
 * Render the canvas as the sidebar tab's body.
 * @returns the canvas iframe, at the URL the store currently holds.
 */
export function CanvasPanel(): JSX.Element {
  const src = useSyncExternalStore(subscribeCanvasUrl, canvasUrlSnapshot)
  return (
    <div style={ROOT_STYLE}>
      <iframe title="画布" src={src} style={FRAME_STYLE} />
    </div>
  )
}
