/**
 * The settings → provider bridge: which row a category's configuration is read
 * from, and what happens when the stored `activeId` names no row.
 *
 * The bug these specs pin: the schema defaults `activeId` to `'default'` while a
 * built-in row's id is `'default:<category>'` (the legacy migration writes
 * exactly that pair). Before the fallback, that mismatch read the whole category
 * as unconfigured — the key, endpoint, and model all came back absent, and the
 * call silently ran on whatever backend the registry happened to offer first.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readActiveAdapter, readActiveMediaProvider } from '../src/settings-lookup.ts'

/** One stored provider row. */
function row(id: string, fields: { adapter?: string; baseUrl?: string; model?: string } = {}): Record<string, unknown> {
  return { id, name: '', custom: false, adapter: fields.adapter ?? '', baseUrl: fields.baseUrl ?? '', model: fields.model ?? '' }
}

/** One stored category; `activeId` omitted models a document that never set one. */
function category(providers: Record<string, unknown>[], activeId?: string): Record<string, unknown> {
  return { ...activeId === undefined ? {} : { activeId }, providers }
}

/** Boot a context whose settings service describes the given namespace value. */
function contextWithSettings(value: unknown, ns = 'roubaai-video-plugin'): Context {
  const ctx = new Context()
  ctx.provide('settings', { describe: () => [{ ns, value }] })
  return ctx
}

describe('readActiveMediaProvider activeId fallback', () => {
  it('falls back to the category\u2019s first row when no activeId is stored', () => {
    // No `activeId` at all and a row id that is not the built-in id: the first
    // row is the only thing the document can mean.
    const ctx = contextWithSettings({
      image: category([row('custom:1', { adapter: 'ark', baseUrl: 'https://ark.example/api/v3', model: 'doubao-seedream-5-0-pro-260628' })]),
      keys: { 'custom:1': 'sk-ark' },
    })

    expect(readActiveMediaProvider(ctx, 'roubaai-video-plugin', 'image')).toEqual({
      apiKey: 'sk-ark',
      baseUrl: 'https://ark.example/api/v3',
      model: 'doubao-seedream-5-0-pro-260628',
    })
  })

  it('resolves the built-in row of a document that never set an activeId', () => {
    const ctx = contextWithSettings({
      image: category([row('default:image', { adapter: 'ark', model: 'doubao-seedream-5-0-pro-260628' })]),
      keys: { 'default:image': 'sk-ark' },
    })

    expect(readActiveMediaProvider(ctx, 'roubaai-video-plugin', 'image')).toEqual({
      apiKey: 'sk-ark',
      model: 'doubao-seedream-5-0-pro-260628',
    })
    expect(readActiveAdapter(ctx, 'image')).toBe('ark')
  })

  it('falls back to the first row when the stored activeId matches no row', () => {
    // The document the legacy migration writes: activeId 'default', row id
    // 'default:image'. It used to read as "nothing configured".
    const ctx = contextWithSettings({
      image: category(
        [row('default:image', { adapter: 'ark', baseUrl: '', model: 'doubao-seedream-5-0-lite-260628' })],
        'default',
      ),
      keys: { 'default:image': 'sk-ark' },
    })

    expect(readActiveMediaProvider(ctx, 'roubaai-video-plugin', 'image')).toEqual({
      apiKey: 'sk-ark',
      model: 'doubao-seedream-5-0-lite-260628',
    })
    expect(readActiveAdapter(ctx, 'image')).toBe('ark')
  })

  it('keeps following a matching activeId rather than the first row', () => {
    const ctx = contextWithSettings({
      video: category(
        [row('a', { adapter: 'maizi', model: 'old' }), row('b', { adapter: 'ark', model: 'doubao-seedance-2-0-260128' })],
        'b',
      ),
      keys: { a: 'sk-maizi', b: 'sk-ark' },
    })

    expect(readActiveMediaProvider(ctx, 'roubaai-video-plugin', 'video')).toEqual({
      apiKey: 'sk-ark',
      model: 'doubao-seedance-2-0-260128',
    })
    expect(readActiveAdapter(ctx, 'video')).toBe('ark')
  })

  it('keeps the stored-id key lookup for a category that lists no rows at all', () => {
    // Nothing to fall back to, so the historical behaviour stands: the key is
    // read from whatever id the document names, and no overrides apply.
    const ctx = contextWithSettings({ image: category([], 'default'), keys: { default: 'sk-ark' } })
    expect(readActiveMediaProvider(ctx, 'roubaai-video-plugin', 'image')).toEqual({ apiKey: 'sk-ark' })
    expect(readActiveAdapter(ctx, 'image')).toBeUndefined()
  })
})

describe('readActiveMediaProvider without a settings document', () => {
  it('reports nothing configured when no settings service is mounted', () => {
    const ctx = new Context()
    expect(readActiveMediaProvider(ctx, 'roubaai-video-plugin', 'image')).toEqual({})
    expect(readActiveAdapter(ctx, 'image')).toBeUndefined()
  })

  it('reports nothing configured for a namespace the document does not carry', () => {
    const ctx = contextWithSettings({ image: category([row('default:image', { adapter: 'ark' })]) })
    expect(readActiveMediaProvider(ctx, 'other-namespace', 'image')).toEqual({})
    expect(readActiveAdapter(ctx, 'image', 'other-namespace')).toBeUndefined()
  })
})
