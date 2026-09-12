/**
 * Provider-owned pricing and caps: a backend carries its own rate table and its
 * own per-model bounds, so the shared tool records what that backend charges and
 * validates against what it accepts without holding any vendor's numbers.
 *
 * An unpriced model or tier must return `undefined` — a guess would bill the
 * ledger with a fabricated figure.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MaiziImageProvider, MaiziVideoProvider } from '../src/index.ts'

describe('Maizi pricing', () => {
  const ctx = new Context()

  it('prices an image from its model and resolution', () => {
    const provider = new MaiziImageProvider(ctx)
    expect(provider.estimateCostUsd('gpt-image-2', '1K')).toBe(0.009)
    expect(provider.estimateCostUsd('gpt-image-2', '4K')).toBe(0.044)
    // A model Maizi prices flat across tiers matches the `any` entry.
    expect(provider.estimateCostUsd('nano-banana-2', 'any')).toBe(0.018)
    expect(provider.estimateCostUsd('unknown-model', '1K')).toBeUndefined()
  })

  it('prices a video from its model, duration and resolution', () => {
    const provider = new MaiziVideoProvider(ctx)
    expect(provider.estimateCostUsd('doubao-seedance-2.0-fast', 4, '480p')).toBeCloseTo(0.2548)
    expect(provider.estimateCostUsd('doubao-seedance-2.5', 5, '720p')).toBeCloseTo(1.35)
    expect(provider.estimateCostUsd('doubao-seedance-2.0', 4, '9999p')).toBeUndefined()
  })
})

describe('Maizi caps', () => {
  const ctx = new Context()

  it('answers per model rather than one fixed bound', () => {
    const provider = new MaiziVideoProvider(ctx)
    expect(provider.caps('doubao-seedance-2.0-mini')).toMatchObject({ maxDuration: 15, maxVideoUrls: 3 })
    expect(provider.caps('doubao-seedance-2.5')).toMatchObject({ maxDuration: 30, maxVideoUrls: 10 })
  })

  it('falls back to its own default model when none is named', () => {
    const provider = new MaiziVideoProvider(ctx)
    // The provider default is a Seedance 2.0 tier, so the 2.0 bounds apply.
    expect(provider.caps()).toMatchObject({ maxDuration: 15, maxImageUrls: 9 })
  })

  it('declares the reference-image cap an image request accepts', () => {
    const provider = new MaiziImageProvider(ctx)
    expect(provider.caps()).toEqual({ maxRefImages: 9 })
  })
})
