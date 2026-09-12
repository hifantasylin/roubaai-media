/**
 * The media service definition (`ctx.media`): a provider registry plus
 * provider-name-based lookup, mirroring `ctx.llm.registerAdapter`'s
 * "abstract service + adapter registration" layering, but for media
 * generation (which does not share LLM's streaming protocol).
 *
 * @module @roubaai/media/service
 */

import type { ImageProvider, MusicProvider, VideoProvider } from './provider.ts'
import type { MediaUrlNormalizer } from './tunnel.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    media: MediaRuntime
    /** Local reference-media URL normalizer (started lazily on first use). */
    mediaUrl: MediaUrlNormalizer
  }
}

/** The `media` service: register/lookup image, video, and music providers. */
export interface MediaRuntime {
  /**
   * Register an image provider under its `provider` name.
   * @param provider - the provider to register; its name must be non-empty and unused.
   * @returns a disposer that unregisters the provider when called.
   */
  registerImageProvider(provider: ImageProvider): () => void
  /**
   * Register a video provider under its `provider` name.
   * @param provider - the provider to register; its name must be non-empty and unused.
   * @returns a disposer that unregisters the provider when called.
   */
  registerVideoProvider(provider: VideoProvider): () => void
  /**
   * Register a music provider under its `provider` name.
   * @param provider - the provider to register; its name must be non-empty and unused.
   * @returns a disposer that unregisters the provider when called.
   */
  registerMusicProvider(provider: MusicProvider): () => void
  /**
   * Resolve an image provider by name.
   * @param provider - the registered provider name; omitted to use the default (first registered).
   * @returns the resolved image provider.
   */
  image(provider?: string): ImageProvider
  /**
   * Resolve a video provider by name.
   * @param provider - the registered provider name; omitted to use the default (first registered).
   * @returns the resolved video provider.
   */
  video(provider?: string): VideoProvider
  /**
   * Resolve a music provider by name.
   * @param provider - the registered provider name; omitted to use the default (first registered).
   * @returns the resolved music provider.
   */
  music(provider?: string): MusicProvider
  /** List registered image providers for config UI / diagnostics.
   * @returns the names of the registered image providers. */
  listImageProviders(): string[]
  /** List registered video providers for config UI / diagnostics.
   * @returns the names of the registered video providers. */
  listVideoProviders(): string[]
  /** List registered music providers for config UI / diagnostics.
   * @returns the names of the registered music providers. */
  listMusicProviders(): string[]
}
