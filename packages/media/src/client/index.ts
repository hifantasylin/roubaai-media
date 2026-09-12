/**
 * Client half of `@roubaai/media`: renders settled media-generation jobs
 * inline on their `job_output` tool-result card. The generated picture is a
 * large `<img>`, video an inline `<video controls>` player, music an
 * `<audio controls>` player — so the user sees the media right where the job
 * settles, and the model never has to copy URLs into its reply text (or call
 * read_image) to "show" a generated asset.
 *
 * The view claims the keyed `job_output` toolview. A claimed key suppresses
 * the generic fallback for EVERY `job_output` result, so the row must cover
 * all of the tool's shapes (see `media-job-row.tsx`: media by kind, raw text
 * otherwise).
 * @module @roubaai/media/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots) and the
// `tool.call.toolview` keyed-slot declaration (its key domain is open, so a
// non-shipped tool name like `job_output` registers into the same hole the
// shipped atomic views use).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { MediaJobRow } from './media-job-row.tsx'

/** Services required before the keyed view can register. */
export const inject = ['slots']

/**
 * Register the `job_output` keyed view.
 * @param ctx - the client cordis context carrying the slots service.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'job_output',
    }, MediaJobRow))
}
