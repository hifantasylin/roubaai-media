import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ROUBA_LOGO_DATA_URL } from './logo.ts'

type RoubaBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/** Corner radius as a share of the edge, matching the workbench's top-bar mark. */
const CORNER_RATIO = 0.22
/** Smallest corner that still reads as a rounded tile at a sidebar's edge. */
const MIN_CORNER_PX = 4

/**
 * Render the RoubaAI mark with the presentation requested by its host surface.
 *
 * The artwork is a square tile rather than a transparent glyph, so it is drawn
 * as a rounded badge at the requested edge instead of inheriting `currentColor`
 * the way the fish mark it replaced did. It carries no accessible name: like the
 * mark before it, it is decorative and the wordmark beside it names the product.
 * @param props - Host-supplied mark presentation.
 * @returns the RoubaAI mark.
 */
export function RoubaBrandMark({ size, className }: RoubaBrandMarkProps) {
  const corner = Math.max(MIN_CORNER_PX, Math.round(size * CORNER_RATIO))
  return (
    <img
      src={ROUBA_LOGO_DATA_URL}
      width={size}
      height={size}
      className={className}
      style={{ borderRadius: `${String(corner)}px`, display: 'block', objectFit: 'contain' }}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

/**
 * Render the Rouba name artwork without its independently slotted mark.
 * @returns the "Rouba DSH" name wordmark.
 */
export function RoubaBrandName() {
  return (
    <span className="dsw-rouba-brand-wordmark" data-dsh-brand="rouba">
      Rouba&nbsp;DSH
    </span>
  )
}
