/**
 * Adapter routing from the configuration side: the catalog the page offers, and
 * the fallback every "cannot" resolves to. A row whose adapter is unmounted or
 * unimplemented must keep the generic endpoint probe rather than fail the
 * connection-test button.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { adapterCatalog, adapterChoice, probeViaAdapter } from '../src/adapters.ts'
import { ROUBAAI_REGISTER_URL } from '../src/shared.ts'

/** A media registry standing in for a deployment that mounted three adapters. */
function mediaRegistry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const missing = (): never => {
    throw new Error('no provider registered under that name')
  }
  return {
    listImageProviders: () => ['maizi'],
    listVideoProviders: () => ['maizi', 'ark'],
    listMusicProviders: () => ['mxapi'],
    image: missing,
    video: missing,
    music: missing,
    ...overrides,
  }
}

describe('adapterCatalog', () => {
  it('reports every category empty when no media plugin is mounted', () => {
    expect(adapterCatalog(new Context())).toEqual({ image: [], video: [], music: [] })
  })

  it('lists what the deployment mounted with a display name and a key page', () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry())
    expect(adapterCatalog(ctx)).toEqual({
      image: [{ name: 'maizi', displayName: '麦子AI', apiKeyUrl: ROUBAAI_REGISTER_URL }],
      video: [
        { name: 'maizi', displayName: '麦子AI', apiKeyUrl: ROUBAAI_REGISTER_URL },
        { name: 'ark', displayName: '火山引擎', apiKeyUrl: 'https://console.volcengine.com/' },
      ],
      // No key page this repository can vouch for: the link is omitted rather
      // than pointed at a guessed address.
      music: [{ name: 'mxapi', displayName: 'MxAPI' }],
    })
  })

  it('shows an unknown adapter under its own registry name with no key link', () => {
    expect(adapterChoice('some-future-backend')).toEqual({
      name: 'some-future-backend',
      displayName: 'some-future-backend',
    })
  })

  it('reports every category empty when the registry throws', () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({
      listVideoProviders: () => {
        throw new Error('registry unavailable')
      },
    }))
    expect(adapterCatalog(ctx)).toEqual({ image: [], video: [], music: [] })
  })
})

describe('probeViaAdapter', () => {
  const draft = { baseUrl: 'https://ark.example/api/v3', apiKey: 'k' }

  it('returns undefined when the row names no adapter', async () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry())
    expect(await probeViaAdapter(ctx, 'video', '', draft)).toBeUndefined()
  })

  it('returns undefined without a media service', async () => {
    expect(await probeViaAdapter(new Context(), 'video', 'ark', draft)).toBeUndefined()
  })

  it('returns undefined when the adapter is not registered', async () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry())
    expect(await probeViaAdapter(ctx, 'video', 'unmounted', draft)).toBeUndefined()
  })

  it('returns undefined for a provider that implements no probe', async () => {
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({ video: () => ({}) }))
    expect(await probeViaAdapter(ctx, 'video', 'ark', draft)).toBeUndefined()
  })

  it('runs the selected adapter\u2019s own probe with the draft values and its three-state answer', async () => {
    const probe = vi.fn(async () => ({ status: 'unconfigured', message: '表单未填写、设置中未保存' }))
    const ctx = new Context()
    ctx.provide('media', mediaRegistry({ video: () => ({ probe }) }))
    expect(await probeViaAdapter(ctx, 'video', 'ark', draft))
      .toEqual({ status: 'unconfigured', message: '表单未填写、设置中未保存' })
    expect(probe).toHaveBeenCalledWith(draft)
  })
})
