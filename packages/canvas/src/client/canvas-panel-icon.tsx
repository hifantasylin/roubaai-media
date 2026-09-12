/**
 * Sidebar icon for the canvas tab: a framed surface holding two connected
 * nodes — the thing the canvas is for.
 * @module @roubaai/canvas/client/canvas-panel-icon
 */

import type { JSX } from 'react'

/**
 * Render the tab's icon.
 * @param props - requested square edge in pixels.
 * @returns the icon, drawn in the surrounding control's color.
 */
export function CanvasPanelIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <rect x="6.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="13.5" y="13" width="3.5" height="3.5" rx="1" />
      <path d="M11 11.25h2.75a0.75 0.75 0 0 1 0.75 0.75v0.75" />
    </svg>
  )
}
