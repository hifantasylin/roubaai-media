/**
 * The plugin entry: mounting `@roubaai/media-ark` must put BOTH backends on
 * `ctx.media` — one image provider and one video provider, both named `ark` —
 * with the config reaching each provider's own default model, and teardown must
 * withdraw both so a hot reload does not hit `already-registered`.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import mediaArk, { ArkImageProvider, ArkVideoProvider } from '../src/index.ts'

const BASE = 'https://ark.example/api/v3'

/** A media registry that records what the plugin registers, and can withdraw it. */
class StubMedia {
  readonly images: unknown[] = []
  readonly videos: unknown[] = []

  registerImageProvider(provider: unknown): () => void {
    this.images.push(provider)
    return () => { this.images.splice(this.images.indexOf(provider), 1) }
  }

  registerVideoProvider(provider: unknown): () => void {
    this.videos.push(provider)
    return () => { this.videos.splice(this.videos.indexOf(provider), 1) }
  }
}

describe('media-ark plugin entry', () => {
  it('registers an image provider and a video provider under the name ark', () => {
    const ctx = new Context()
    const media = new StubMedia()
    ctx.provide('media', media)

    mediaArk.apply(ctx as never, { baseUrl: BASE })

    expect(media.images).toHaveLength(1)
    expect(media.videos).toHaveLength(1)
    expect(media.images[0]).toBeInstanceOf(ArkImageProvider)
    expect(media.videos[0]).toBeInstanceOf(ArkVideoProvider)
    expect((media.images[0] as ArkImageProvider).provider).toBe('ark')
    expect((media.videos[0] as ArkVideoProvider).provider).toBe('ark')
  })

  it('routes each configured model to the provider that owns it', () => {
    const ctx = new Context()
    const media = new StubMedia()
    ctx.provide('media', media)

    mediaArk.apply(ctx as never, {
      baseUrl: BASE,
      imageModel: 'doubao-seedream-4-0-250828',
      videoModel: 'doubao-seedance-2-0-260128',
    })

    expect((media.images[0] as ArkImageProvider).defaultModel).toBe('doubao-seedream-4-0-250828')
    expect((media.videos[0] as ArkVideoProvider).defaultModel).toBe('doubao-seedance-2-0-260128')
  })

  it('withdraws both registrations on teardown', () => {
    const ctx = new Context()
    const media = new StubMedia()
    ctx.provide('media', media)

    const dispose = mediaArk.apply(ctx as never, { baseUrl: BASE })
    dispose()

    expect(media.images).toHaveLength(0)
    expect(media.videos).toHaveLength(0)
  })
})
