/**
 * Process-local media provider registry (`ctx.media` implementation). The
 * registry is itself the whitelist: only explicitly registered providers are
 * reachable, and a missing registration surfaces as a `NO_PROVIDER` error
 * (distinct from `MISSING_CREDENTIAL`, which the provider raises when its own
 * credential resolve returns `undefined`).
 *
 * Registration is reversible: `register*Provider` returns a disposer and
 * binds to the apply fiber, so unloading the provider plugin withdraws its
 * providers (design constraint #2 — no global side effect left behind).
 *
 * @module @roubaai/media/media-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageProvider, MusicProvider, VideoProvider } from './provider.ts'
import type { MediaRuntime } from './service.ts'

/** Raised when `image()`/`video()`/`music()` find no registered provider (or none by name). */
export class NoProviderError extends Error {
  readonly code = 'NO_PROVIDER'
  constructor(message: string) {
    super(message)
    this.name = 'NoProviderError'
  }
}

/** The process-local media registry, registered as `ctx.media`. */
export class MediaRuntimeLocal extends Service implements MediaRuntime {
  private readonly images = new Map<string, ImageProvider>()
  private readonly videos = new Map<string, VideoProvider>()
  private readonly musics = new Map<string, MusicProvider>()

  constructor(ctx: Context) {
    super(ctx, 'media')
  }

  registerImageProvider(provider: ImageProvider): () => void {
    const name = provider.provider
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('media: an image provider needs a non-empty provider name')
    }
    if (this.images.has(name)) {
      throw new Error(`media: image provider "${name}" is already registered`)
    }
    const dispose = this.ctx.effect(function* (this: MediaRuntimeLocal) {
      this.images.set(name, provider)
      yield () => {
        this.images.delete(name)
      }
    }.bind(this), 'media.registerImageProvider()')
    return () => void dispose()
  }

  registerVideoProvider(provider: VideoProvider): () => void {
    const name = provider.provider
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('media: a video provider needs a non-empty provider name')
    }
    if (this.videos.has(name)) {
      throw new Error(`media: video provider "${name}" is already registered`)
    }
    const dispose = this.ctx.effect(function* (this: MediaRuntimeLocal) {
      this.videos.set(name, provider)
      yield () => {
        this.videos.delete(name)
      }
    }.bind(this), 'media.registerVideoProvider()')
    return () => void dispose()
  }

  image(provider?: string): ImageProvider {
    if (provider !== undefined) {
      const found = this.images.get(provider)
      if (found === undefined) {
        throw new NoProviderError(`media: no image provider registered under "${provider}"`)
      }
      return found
    }
    const first = this.images.values().next().value
    if (first === undefined) {
      throw new NoProviderError('media: no image provider is registered')
    }
    return first
  }

  video(provider?: string): VideoProvider {
    if (provider !== undefined) {
      const found = this.videos.get(provider)
      if (found === undefined) {
        throw new NoProviderError(`media: no video provider registered under "${provider}"`)
      }
      return found
    }
    const first = this.videos.values().next().value
    if (first === undefined) {
      throw new NoProviderError('media: no video provider is registered')
    }
    return first
  }

  registerMusicProvider(provider: MusicProvider): () => void {
    const name = provider.provider
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('media: a music provider needs a non-empty provider name')
    }
    if (this.musics.has(name)) {
      throw new Error(`media: music provider "${name}" is already registered`)
    }
    const dispose = this.ctx.effect(function* (this: MediaRuntimeLocal) {
      this.musics.set(name, provider)
      yield () => {
        this.musics.delete(name)
      }
    }.bind(this), 'media.registerMusicProvider()')
    return () => void dispose()
  }

  music(provider?: string): MusicProvider {
    if (provider !== undefined) {
      const found = this.musics.get(provider)
      if (found === undefined) {
        throw new NoProviderError(`media: no music provider registered under "${provider}"`)
      }
      return found
    }
    const first = this.musics.values().next().value
    if (first === undefined) {
      throw new NoProviderError('media: no music provider is registered')
    }
    return first
  }

  listImageProviders(): string[] {
    return [...this.images.keys()]
  }

  listVideoProviders(): string[] {
    return [...this.videos.keys()]
  }

  listMusicProviders(): string[] {
    return [...this.musics.keys()]
  }
}

export default MediaRuntimeLocal
