/**
 * Per-model capability on the configuration side: the catalogue the page reads
 * carries each model's own facts, and the settings shape carries the row's
 * chosen tier.
 *
 * Two rules these specs pin. First, the capability travels WITH the catalogue
 * answer, host-side, so a model choice and what that model accepts can never
 * come from two different reads and disagree. Second, a backend that states no
 * capability — or states one it cannot compute — leaves the option exactly as
 * it was: the page must show no constraint rather than an invented one.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { modelsViaAdapter } from '../src/adapters.ts'
import {
  MEDIA_CATEGORY_DEFAULTS,
  MEDIA_IMAGE_DEFAULT_TIER,
  defaultProviderEntry,
  resolveRoubaaiMediaSettings,
} from '../src/shared.ts'
import type { MediaModelCapabilityView } from '../src/shared.ts'

/** The lite-class capability the Ark adapter states for the default model. */
const LITE_CAPABILITY: MediaModelCapabilityView = {
  id: 'doubao-seedream-5-0-260128',
  label: 'lite',
  tiers: ['2K', '3K', '4K'],
  minPixels: 3_686_400,
  maxRefImages: 14,
  aspectRatios: ['1:1', '16:9'],
  note: 'lite 档',
}

const MODELS = [
  { id: 'doubao-seedream-5-0-260128', status: 'available', taskTypes: ['ImageGeneration'] },
  { id: 'doubao-seedream-5-0-pro-260628', taskTypes: ['ImageGeneration'] },
]

/** A media registry whose image slot answers with the given provider. */
function mediaRegistry(provider: unknown): Record<string, unknown> {
  const missing = (): never => {
    throw new Error('no provider registered under that name')
  }
  return {
    listImageProviders: () => ['ark'],
    listVideoProviders: () => [],
    listMusicProviders: () => [],
    image: () => provider,
    video: missing,
    music: missing,
  }
}

/** One context whose image adapter is the given provider. */
function ctxWith(provider: unknown): Context {
  const ctx = new Context()
  ctx.provide('media', mediaRegistry(provider))
  return ctx
}

describe('modelsViaAdapter capability enrichment', () => {
  it('attaches each model its own capability, from the backend that serves it', async () => {
    const provider = {
      listModels: async () => MODELS,
      capabilities: (model?: string) => model === LITE_CAPABILITY.id ? LITE_CAPABILITY : undefined,
    }

    const result = await modelsViaAdapter(ctxWith(provider), 'image', 'ark', { baseUrl: '', apiKey: '' })

    expect(result.models[0]).toEqual({ ...MODELS[0], capability: LITE_CAPABILITY })
    // A model its backend cannot describe keeps its own fields and gains
    // nothing: an absent capability is "not stated", never "no constraint".
    expect(result.models[1]).toEqual(MODELS[1])
  })

  it('leaves every option untouched for a backend that states no capability', async () => {
    const provider = { listModels: async () => MODELS }

    const result = await modelsViaAdapter(ctxWith(provider), 'image', 'ark', { baseUrl: '', apiKey: '' })

    expect(result.models).toEqual(MODELS)
  })

  it('keeps the catalogue readable when the capability accessor refuses an id', async () => {
    const provider = {
      listModels: async () => MODELS,
      capabilities: () => {
        throw new Error('this adapter cannot place the model')
      },
    }

    const result = await modelsViaAdapter(ctxWith(provider), 'image', 'ark', { baseUrl: '', apiKey: '' })

    expect(result.models).toEqual(MODELS)
  })
})

describe('image defaults and the row tier', () => {
  it('defaults the image model to the lite class and the tier to 2K', () => {
    expect(MEDIA_CATEGORY_DEFAULTS.image.model).toBe('doubao-seedream-5-0-260128')
    expect(MEDIA_IMAGE_DEFAULT_TIER).toBe('2K')
  })

  it('seeds a built-in row with no tier, so the default stays the default', () => {
    expect(defaultProviderEntry('image')).toMatchObject({
      adapter: 'ark',
      model: '',
      resolution: '',
    })
  })

  it('resolves a stored row tier and defaults it to empty when absent', () => {
    const resolved = resolveRoubaaiMediaSettings({
      image: {
        activeId: 'default:image',
        providers: [
          { id: 'default:image', name: '', custom: false, adapter: 'ark', baseUrl: '', model: '', resolution: '3K' },
          { id: 'custom:1', name: 'x', custom: true, adapter: 'ark', baseUrl: 'https://ark.example', model: 'm' },
        ],
      },
    })

    expect(resolved.image.providers[0]!.resolution).toBe('3K')
    // A document written before the tier existed reads as '' — "follow the
    // model default" — rather than as a missing field consumers must guard.
    expect(resolved.image.providers[1]!.resolution).toBe('')
  })

  it('keeps the built-in row endpoint and model in sync with the category defaults', () => {
    const resolved = resolveRoubaaiMediaSettings({})
    const builtIn = resolved.image.providers[0]!
    expect(builtIn.model).toBe(MEDIA_CATEGORY_DEFAULTS.image.model)
    expect(builtIn.baseUrl).toBe(MEDIA_CATEGORY_DEFAULTS.image.baseUrl)
    expect(builtIn.resolution).toBe('')
  })
})
