/**
 * Package-owned invariant companion for `@roubaai/media`.
 *
 * The media registry is itself the whitelist (constraint #2 / design
 * §6.3): a name returned by `listImageProviders`/`listVideoProviders` must
 * resolve back through `image(name)`/`video(name)` to a provider carrying a
 * non-empty `provider` name — otherwise the list/name-lookup surface and the
 * registration table have drifted.
 *
 * @module @roubaai/media/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@roubaai/media'

/** Cordis companion plugin name. */
export const name = 'roubaai-media-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Verify every listed provider name resolves back to a non-empty provider. */
function checkNames(ctx: Context, fail: InvariantFailure): void {
  for (const imageName of ctx.media.listImageProviders()) {
    const resolved = ctx.media.image(imageName)
    if (resolved.provider !== imageName || imageName.length === 0) {
      fail(`image provider "${imageName}" resolves to "${resolved.provider}" — registry list/name drift`)
    }
  }
  for (const videoName of ctx.media.listVideoProviders()) {
    const resolved = ctx.media.video(videoName)
    if (resolved.provider !== videoName || videoName.length === 0) {
      fail(`video provider "${videoName}" resolves to "${resolved.provider}" — registry list/name drift`)
    }
  }
}

/** Install the registry list/name-consistency check. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  checkNames(ctx, fail)
}, { inject: ['media'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
