import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  ImageProvider,
  VideoProvider,
  MediaRuntimeLocal,
  NoProviderError,
} from '../src/index.ts'
import type {
  ImageCaps,
  ImageGenerateInput,
  ImageGenerationResult,
  ProviderProbeResult,
  VideoCaps,
  VideoGenerateInput,
  VideoGenerationResult,
  VideoTaskHandle,
} from '../src/index.ts'

/**
 * Minimal concrete providers for registry/contract tests. They return canned
 * results and record their `generate`/`submit`/`finalize` calls so the
 * registry (not the provider behavior) is what is under test.
 */
class StubImageProvider extends ImageProvider {
  readonly provider = 'stub-image'
  readonly defaultModel = 'stub-image-v1'
  calls = 0
  async generate(_input: ImageGenerateInput, _signal?: AbortSignal): Promise<ImageGenerationResult> {
    this.calls++
    return {
      kind: 'image',
      attachmentRef: 'att:stub',
      attachment: { attachmentId: AttachmentId('att:stub'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
      mediaType: 'image/png',
      providerMeta: { provider: this.provider, model: this.defaultModel },
    }
  }
  caps(): ImageCaps {
    return { maxRefImages: 9 }
  }
  estimateCostUsd(): number | undefined {
    return undefined
  }
  async probe(): Promise<ProviderProbeResult> {
    return { ok: true, message: 'stub' }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

class StubVideoProvider extends VideoProvider {
  readonly provider = 'stub-video'
  readonly defaultModel = 'stub-video-v1'
  submits = 0
  async submit(_input: VideoGenerateInput, _signal?: AbortSignal): Promise<VideoTaskHandle> {
    this.submits++
    return { taskId: 'stub-task', poll: async () => ({ status: 'running' }) }
  }
  async finalize(_handle: VideoTaskHandle, _signal?: AbortSignal): Promise<VideoGenerationResult> {
    return {
      kind: 'video',
      attachmentRef: 'att:stub-video',
      mediaType: 'video/mp4',
      mediaRef: { url: 'https://stub.invalid/v.mp4', mediaType: 'video/mp4', expiresAt: Date.now() + 86_400_000 },
      providerMeta: { provider: this.provider, model: this.defaultModel, taskId: 'stub-task' },
    }
  }
  caps(): VideoCaps {
    return { minDuration: 4, maxDuration: 15, maxImageUrls: 9, maxVideoUrls: 3, maxAudioUrls: 3 }
  }
  estimateCostUsd(): number | undefined {
    return undefined
  }
  async probe(): Promise<ProviderProbeResult> {
    return { ok: true, message: 'stub' }
  }
  async testConnection(): Promise<boolean> {
    return true
  }
}

describe('ImageProvider / VideoProvider abstract seam', () => {
  it('exposes the abstract members a provider must implement', () => {
    const image = new StubImageProvider()
    expect(image.provider).toBe('stub-image')
    expect(image.defaultModel).toBe('stub-image-v1')

    const video = new StubVideoProvider()
    expect(video.provider).toBe('stub-video')
    expect(video.defaultModel).toBe('stub-video-v1')
  })
})

describe('MediaRuntimeLocal registry', () => {
  it('registers providers, lists them, and resolves by name or by default', () => {
    const ctx = new Context()
    const runtime = new MediaRuntimeLocal(ctx)

    runtime.registerImageProvider(new StubImageProvider())
    runtime.registerVideoProvider(new StubVideoProvider())

    expect(runtime.listImageProviders()).toEqual(['stub-image'])
    expect(runtime.listVideoProviders()).toEqual(['stub-video'])

    // Default lookup returns the first (and only) registered provider.
    expect(runtime.image().provider).toBe('stub-image')
    expect(runtime.video().provider).toBe('stub-video')

    // Name lookup returns the same instance.
    expect(runtime.image('stub-image').provider).toBe('stub-image')
    expect(runtime.video('stub-video').provider).toBe('stub-video')
  })

  it('returns a disposer that unregisters the provider (reversible effect)', () => {
    const ctx = new Context()
    const runtime = new MediaRuntimeLocal(ctx)

    const disposeImage = runtime.registerImageProvider(new StubImageProvider())
    const disposeVideo = runtime.registerVideoProvider(new StubVideoProvider())

    expect(runtime.listImageProviders()).toEqual(['stub-image'])
    expect(runtime.listVideoProviders()).toEqual(['stub-video'])

    disposeImage()
    disposeVideo()

    expect(runtime.listImageProviders()).toEqual([])
    expect(runtime.listVideoProviders()).toEqual([])

    // After withdrawal, lookup surfaces NO_PROVIDER.
    expect(() => runtime.image()).toThrow(NoProviderError)
    expect(() => runtime.video()).toThrow(NoProviderError)
  })

  it('throws NO_PROVIDER when no provider is registered', () => {
    const ctx = new Context()
    const runtime = new MediaRuntimeLocal(ctx)

    expect(() => runtime.image()).toThrow(NoProviderError)
    expect(() => runtime.video()).toThrow(NoProviderError)

    try {
      runtime.image()
    } catch (error) {
      expect((error as NoProviderError).code).toBe('NO_PROVIDER')
    }
  })

  it('throws NO_PROVIDER when a named provider is not registered', () => {
    const ctx = new Context()
    const runtime = new MediaRuntimeLocal(ctx)

    runtime.registerImageProvider(new StubImageProvider())

    expect(() => runtime.image('missing')).toThrow(NoProviderError)
    expect(() => runtime.video('missing')).toThrow(NoProviderError)
  })

  it('rejects a duplicate registration under the same name', () => {
    const ctx = new Context()
    const runtime = new MediaRuntimeLocal(ctx)

    runtime.registerImageProvider(new StubImageProvider())
    expect(() => runtime.registerImageProvider(new StubImageProvider()))
      .toThrow(/already registered/)

    runtime.registerVideoProvider(new StubVideoProvider())
    expect(() => runtime.registerVideoProvider(new StubVideoProvider()))
      .toThrow(/already registered/)
  })

  it('rejects a provider with an empty name', () => {
    const ctx = new Context()
    const runtime = new MediaRuntimeLocal(ctx)

    const emptyImage = new StubImageProvider()
    Object.defineProperty(emptyImage, 'provider', { value: '', writable: true })
    expect(() => runtime.registerImageProvider(emptyImage)).toThrow(/non-empty provider name/)

    const emptyVideo = new StubVideoProvider()
    Object.defineProperty(emptyVideo, 'provider', { value: '', writable: true })
    expect(() => runtime.registerVideoProvider(emptyVideo)).toThrow(/non-empty provider name/)
  })

  it('withdraws the media service when the owning fiber unloads (constraint #2)', async () => {
    const ctx = new Context()
    // Registering the runtime via a plugin fiber so its disposer is bound to
    // that fiber; disposing the fiber removes ctx.media entirely.
    const fiber = await ctx.plugin({
      name: 'test-media',
      apply(inner: Context) {
        new MediaRuntimeLocal(inner)
      },
    })

    expect(ctx.get('media')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('media')).toBeUndefined()
  })
})
