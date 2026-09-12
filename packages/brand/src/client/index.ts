/** Rouba DSH brand occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { RoubaBrandMark, RoubaBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * Rouba owns the brand slots unconditionally: deployments that mount this
 * plugin are Rouba-branded and must disable the official occupant.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, RoubaBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, RoubaBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, RoubaBrandMark)
      })))
}
