/**
 * MxAPI music provider plugin: registers the music provider with `ctx.media`.
 * Registering a provider is all that is needed to wire it to the
 * `generate_music` tool (which stays provider-agnostic).
 *
 * @module @roubaai/media-mxapi
 */

import type { Context } from '@deepseek-ai/cordis'
import { MxapiMusicProvider } from './mxapi-music-provider.ts'

export { MxapiMusicProvider, MxapiApiError, MissingCredentialError } from './mxapi-music-provider.ts'
export type { MxapiMusicConfig } from './mxapi-music-provider.ts'

export const name = 'roubaai-media-mxapi'
export const inject = ['media', 'credentials']

/** Plugin config; every field is optional. */
export interface Config {
  /** Endpoint base override (defaults to the public MxAPI v2 music base). */
  baseUrl?: string
  /** Default Suno model version (mv); defaults to `chirp-bluejay` (v4.5+). */
  model?: string
  /** Credential reference (environment-variable name); defaults to `MXAPI_API_KEY`. */
  apiKeyEnv?: string
}

export function apply(ctx: Context, config: Config = {}): () => void {
  return ctx.media.registerMusicProvider(new MxapiMusicProvider(ctx, {
    ...config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {},
    ...config.model !== undefined ? { model: config.model } : {},
    ...config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {},
  }))
}

export default { name, inject, apply }
