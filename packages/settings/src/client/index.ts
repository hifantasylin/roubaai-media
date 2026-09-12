/**
 * Client half of `@roubaai/settings`: contributes the "RoubaAI" section to
 * the DSH Settings shell. The section reads and writes the provider
 * configuration through the host half's fenced route, so this half owns no
 * state of its own — it is a registration and nothing else.
 *
 * The section appears once the shell's own declaration is on the ledger
 * (`slots.inject` waits for it), which is why the registration goes through
 * `inject` rather than a bare `register`: a plugin that loads before the
 * settings shell would otherwise contribute to nothing.
 * @module @roubaai/settings/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RoubaaiVideoSettingsSection } from './settings-section.tsx'

/** Services required before the section can be contributed. */
export const inject = ['slots']

/** The settings nav label (the shell localizes its own chrome, not ours). */
function label(): string {
  return 'RoubaAI'
}

/**
 * Register the settings section.
 * @param ctx - the client cordis context carrying the slots service.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'roubaai-settings',
    order: 100,
    label,
  }, RoubaaiVideoSettingsSection))
}
