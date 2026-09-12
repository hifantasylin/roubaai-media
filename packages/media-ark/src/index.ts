/**
 * Volcengine Ark media provider plugin: registers the image and video providers
 * with `ctx.media`. Registering a provider is all that is needed to wire it to
 * `generate_image` / `generate_video`, which stay provider-agnostic — the
 * Settings page selects this adapter by naming `ark` on the active row.
 * @module @roubaai/media-ark
 */

import type { Context } from '@deepseek-ai/cordis'
import { ArkVideoProvider } from './ark-video-provider.ts'
import { ArkImageProvider } from './ark-image-provider.ts'

export {
  ArkVideoProvider,
  ARK_API_KEY_REF,
  ARK_VIDEO_BASE_URL,
  DEFAULT_VIDEO_MODEL,
} from './ark-video-provider.ts'
export type { ArkVideoConfig } from './ark-video-provider.ts'
export {
  ArkImageProvider,
  ARK_IMAGE_BASE_URL,
  DEFAULT_IMAGE_MODEL,
} from './ark-image-provider.ts'
export type { ArkImageConfig } from './ark-image-provider.ts'
export { MissingCredentialError } from './errors.ts'
export { parseArkModels, filterArkModels, fetchArkModels, formatModelIds } from './ark-models.ts'
export type { ArkModelFilter } from './ark-models.ts'
export { DEFAULT_SETTINGS_NAMESPACE } from './settings-config.ts'

export const name = 'roubaai-media-ark'
export const inject = ['media', 'credentials']

/** Plugin config; every field is optional. */
export interface Config {
  /** Endpoint base override (defaults to the public Ark API). */
  baseUrl?: string
  /** Default video model id. */
  videoModel?: string
  /** Default image model id. */
  imageModel?: string
  /** Credential reference (environment-variable name); defaults to `ARK_API_KEY`. */
  apiKeyEnv?: string
  /** Settings namespace the roubaai Settings page owns. */
  settingsNamespace?: string
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const shared = {
    ...config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {},
    ...config.apiKeyEnv !== undefined ? { apiKeyEnv: config.apiKeyEnv } : {},
    ...config.settingsNamespace !== undefined ? { settingsNamespace: config.settingsNamespace } : {},
  }
  const disposeImage = ctx.media.registerImageProvider(new ArkImageProvider(ctx, {
    ...shared,
    ...config.imageModel !== undefined ? { model: config.imageModel } : {},
  }))
  const disposeVideo = ctx.media.registerVideoProvider(new ArkVideoProvider(ctx, {
    ...shared,
    ...config.videoModel !== undefined ? { model: config.videoModel } : {},
  }))
  // Unregister on teardown so a hot reload does not hit `already-registered`.
  return () => {
    disposeImage()
    disposeVideo()
  }
}

export default { name, inject, apply }
