/**
 * The media-generation capability family: a provider seam (`ctx.media`) plus
 * the `generate_image` / `generate_video` tools. Provider implementations
 * (such as `@roubaai/media-maizi`) register themselves with
 * `ctx.media.registerImageProvider` / `registerVideoProvider` — registering a
 * provider is all that is needed to wire it to the tools, which stay
 * provider-agnostic.
 *
 * @module @roubaai/media
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context augmentation (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { MediaRuntimeLocal } from './media-local.ts'
import { MediaUrlNormalizer } from './tunnel.ts'
import { registerWebRoutes } from './media-cache.ts'
import { registerAssetRoutes } from './asset-routes.ts'
import { registerOpenAiRoutes } from './openai-facade.ts'
import { registerGenerateImage } from './tools/generate-image.ts'
import { registerGenerateVideo } from './tools/generate-video.ts'
import { registerGenerateMusic } from './tools/generate-music.ts'
import { registerMediaReferenceUrl } from './tools/media-reference-url.ts'
import { registerMediaAssetSave } from './tools/media-asset-save.ts'
import { registerExtractFrame } from './tools/extract-frame.ts'
import { registerMediaCostSummary } from './tools/media-cost-summary.ts'
// Import for its declaration-merging side effect: extends `JobKindMap` with
// `'media-video'` so `ctx.jobs.start({ kind: 'media-video', ... })` type-checks.
import './job-kind.ts'

export { ImageProvider, MusicProvider, VideoProvider } from './provider.ts'
export { DEFAULT_IMAGE_RESOLUTION } from './provider.ts'
export { MEDIA_SETTINGS_NAMESPACE, readActiveAdapter, readActiveMediaProvider } from './settings-lookup.ts'
export type { ActiveMediaProvider, MediaSettingsCategory } from './settings-lookup.ts'
export type {
  ImageCaps,
  ImageGenerationResult,
  ImageGenerateInput,
  ImageRunInfo,
  MediaModelCapability,
  MediaModelInfo,
  MediaProgress,
  MediaRef,
  MusicGenerateInput,
  MusicGenerationResult,
  MusicTaskHandle,
  MusicTaskPoll,
  MusicTrackInfo,
  ProviderProbeDraft,
  ProviderProbeResult,
  VideoCaps,
  VideoGenerationResult,
  VideoGenerateInput,
  VideoTaskHandle,
  VideoTaskPoll,
} from './provider.ts'
export type { MediaRuntime } from './service.ts'
export { NoProviderError, MediaRuntimeLocal } from './media-local.ts'
export { OPENAI_FACADE_PREFIX, registerOpenAiRoutes, mapImageRequest } from './openai-facade.ts'
export { ASSETS_ROUTE_PREFIX, registerAssetRoutes } from './asset-routes.ts'
export { ASSETS_DIR_NAME, assetsRoot, resolveAssetPath, stagingRoot } from './asset-root.ts'
export { ASSET_CATEGORIES, landMediaAsset, resolveLandingPath } from './asset-landing.ts'
export { MEDIA_ROUTE_PREFIX, registerWebRoutes } from './media-cache.ts'

export const name = 'roubaai-media'
export const inject = ['tools', 'jobs', 'attachments', 'webServer']

export function apply(ctx: Context): void {
  // Register the process-local media registry as `ctx.media`; the `Service`
  // constructor registers it and it is withdrawn with this fiber.
  new MediaRuntimeLocal(ctx)
  // Register the local-reference URL normalizer as `ctx.mediaUrl`. It is a
  // `Service` (lifecycle bound to this apply fiber) and starts its static
  // server + tunnel lazily on the first local reference.
  new MediaUrlNormalizer(ctx)
  // Same-origin media stream + cache-lookup routes (see media-cache.ts): the
  // browser plays cached video/audio from the harness host, not the provider
  // CDN. Requires the host webserver (web deployments); the plugin's tools
  // remain usable headless where no webServer route can mount.
  ctx.effect(() => registerWebRoutes(ctx.webServer), 'roubaai-media: media stream routes')
  // OpenAI-compatible facade for a browser workbench (the canvas): the channel's
  // requests reach the same providers as the agent tools while the key stays in
  // this process. See openai-facade.ts for what it does not serve yet.
  ctx.effect(() => registerOpenAiRoutes(ctx), 'roubaai-media: openai facade routes')
  // Read-only listing/serving of `<root>/.assets/**`, so the canvas can display
  // an asset (image or video) by URL instead of importing a second copy.
  ctx.effect(() => registerAssetRoutes(ctx), 'roubaai-media: asset tree routes')
  registerGenerateImage(ctx)
  registerGenerateVideo(ctx)
  registerGenerateMusic(ctx)
  registerMediaReferenceUrl(ctx)
  registerMediaAssetSave(ctx)
  registerExtractFrame(ctx)
  registerMediaCostSummary(ctx)
}

export default { name, inject, apply }
