/**
 * Volcengine Ark media provider plugin: registers the video provider with
 * `ctx.media`. Registering a provider is all that is needed to wire it to
 * `generate_video`, which stays provider-agnostic — the Settings page selects
 * this adapter by naming `ark` on the active video row.
 * @module @roubaai/media-ark
 */

import type { Context } from '@deepseek-ai/cordis'
import { ArkVideoProvider } from './ark-video-provider.ts'

export {
  ArkVideoProvider,
  MissingCredentialError,
  ARK_API_KEY_REF,
  ARK_VIDEO_BASE_URL,
  DEFAULT_VIDEO_MODEL,
} from './ark-video-provider.ts'
export type { ArkVideoConfig } from './ark-video-provider.ts'
export { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'

export const name = 'roubaai-media-ark'
export const inject = ['media', 'credentials']

/** Plugin config; every field is optional. */
export interface Config {
  /** Endpoint base override (defaults to the public Ark API). */
  baseUrl?: string
  /** Default video model id. */
  videoModel?: string
  /** Credential reference (environment-variable name); defaults to `ARK_API_KEY`. */
  apiKeyEnv?: string
  /** Settings namespace the roubaai Settings page owns. */
  settingsNamespace?: string
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const disposeVideo = ctx.media.registerVideoProvider(new ArkVideoProvider(ctx, {
    ...config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {},
    ...config.videoModel !== undefined ? { model: config.videoModel } : {},
    ...config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {},
    ...config.settingsNamespace !== undefined ? { settingsNamespace: config.settingsNamespace } : {},
  }))
  // Unregister on teardown so a hot reload does not hit `already-registered`.
  return () => {
    disposeVideo()
  }
}

export default { name, inject, apply }
