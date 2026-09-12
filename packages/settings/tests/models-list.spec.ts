/**
 * The configuration page's model catalogue read: which provider answers, what
 * the form's unsaved draft is allowed to override, and what a backend that
 * cannot list models reports.
 *
 * Three outcomes are pinned here, because the form depends on all three: a
 * catalogue from a backend that implements one, the same call carrying the
 * card's unsaved endpoint and key, and an empty list with a reason (rather than
 * an error) for a backend that cannot list models at all. A real failure — an
 * unmounted adapter, a backend that refused the call — must stay a failure.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { modelsViaAdapter } from '../src/adapters.ts'

const MODELS = [
  { id: 'doubao-seedream-5-0-pro-260628', status: 'available', taskTypes: ['ImageGeneration'] },
]

/** A media registry whose image slot answers with the given provider. */
function mediaRegistry(provider: unknown): Record<string, unknown> {
  const missing = (): never => {
    throw new Error('no provider registered under that name')
  }
  return {
    listImageProviders: () => ['ark'],
    listVideoProviders: () => ['ark'],
    listMusicProviders: () => ['mxapi'],
    image: () => provider,
    video: missing,
    music: missing,
  }
}

describe('modelsViaAdapter', () => {
  it('reads the catalogue from a backend that implements listModels', async () => {
    const listModels = vi.fn(async () => MODELS)
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({ listModels }))

    expect(await modelsViaAdapter(ctx, 'image', 'ark', { baseUrl: '', apiKey: '' }))
      .toEqual({ models: MODELS })
    expect(listModels).toHaveBeenCalledTimes(1)
  })

  it('prefers the draft-aware call and hands it the form\u2019s endpoint and key', async () => {
    const draftModels = vi.fn(async () => MODELS)
    const listModels = vi.fn(async () => [])
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({ listModels, listModelsWithDraft: draftModels }))

    const draft = { baseUrl: 'https://ark.example/api/v3', apiKey: 'draft-key' }
    expect(await modelsViaAdapter(ctx, 'image', 'ark', draft)).toEqual({ models: MODELS })
    expect(draftModels).toHaveBeenCalledWith(draft, undefined)
    expect(listModels).not.toHaveBeenCalled()
  })

  it('reports an empty catalogue with a reason for a backend that cannot list models', async () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({ probe: async () => ({ status: 'ok', message: '' }) }))

    const result = await modelsViaAdapter(ctx, 'image', 'ark', { baseUrl: '', apiKey: '' })
    expect(result.models).toEqual([])
    expect(result.message).toMatch(/不支持列出模型/)
  })

  it('propagates the backend\u2019s own failure instead of reporting no models', async () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({
      listModels: async () => {
        throw new Error('Ark model list failed [403]')
      },
    }))

    await expect(modelsViaAdapter(ctx, 'image', 'ark', { baseUrl: '', apiKey: '' }))
      .rejects.toThrow('Ark model list failed [403]')
  })

  it('refuses an adapter this deployment did not mount', async () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({ listModels: async () => MODELS }))

    await expect(modelsViaAdapter(ctx, 'video', 'ark', { baseUrl: '', apiKey: '' }))
      .rejects.toThrow(/未挂载/)
  })

  it('refuses when the deployment mounted no media service', async () => {
    await expect(modelsViaAdapter(new Context(), 'image', 'ark', { baseUrl: '', apiKey: '' }))
      .rejects.toThrow(/ctx\.media/)
  })
})
