import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type RoubaBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the Rouba mark with the presentation requested by its host surface.
 * Reuses the shared fish mark until a distinct Rouba logo is supplied.
 * @param props - Host-supplied mark presentation.
 * @returns the shared fish mark.
 */
export function RoubaBrandMark({ size, className }: RoubaBrandMarkProps) {
  return <FishLogo size={size} className={className} />
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
