/**
 * Package-owned invariant companion for `@roubaai/media-maizi`.
 *
 * The Maizi providers follow design constraint #6: a provider holds no
 * plaintext API key — it stores only the credential *reference name* and
 * resolves the secret per operation through `ctx.credentials`. This companion
 * pins that contract at registration time.
 *
 * @module @roubaai/media-maizi/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@roubaai/media-maizi'

/** Cordis companion plugin name. */
export const name = 'roubaai-media-maizi-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The only key-bearing field a Maizi provider may expose is the reference name. */
function checkNoPlaintextKey(ctx: Context, fail: InvariantFailure): void {
  for (const providerName of ctx.media.listImageProviders()) {
    const provider = ctx.media.image(providerName) as unknown as Record<string, unknown>
    if (provider['apiKey'] !== undefined) {
      fail(`image provider "${providerName}" exposes a plaintext apiKey`)
    }
  }
  for (const providerName of ctx.media.listVideoProviders()) {
    const provider = ctx.media.video(providerName) as unknown as Record<string, unknown>
    if (provider['apiKey'] !== undefined) {
      fail(`video provider "${providerName}" exposes a plaintext apiKey`)
    }
  }
}

/** Install the no-plaintext-key check. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  checkNoPlaintextKey(ctx, fail)
}, { inject: ['media'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
