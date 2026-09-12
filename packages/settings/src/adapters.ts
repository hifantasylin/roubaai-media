/**
 * The Settings page's view of `ctx.media`: which adapters this deployment
 * mounted, and how a row's connectivity probe reaches the adapter that owns it.
 *
 * Both faces are structural rather than an import of `@roubaai/media`, so the
 * configuration package stays independent of any backend package and keeps
 * working on a surface where no media plugin is mounted at all. This module
 * lives beside the route rather than inside it so each half is testable without
 * booting a web server.
 * @module @roubaai/settings/adapters
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MediaCategory } from './shared.ts'

/** The `ctx.media` face this module reads. */
interface MediaRegistryFace {
  image(name?: string): unknown
  video(name?: string): unknown
  music(name?: string): unknown
  listImageProviders(): string[]
  listVideoProviders(): string[]
  listMusicProviders(): string[]
}

/** A provider's draft-value probe, as this module consumes it. */
interface ProviderProbeFace {
  probe(draft: AdapterProbeDraft): Promise<{ ok: boolean, message: string }>
}

/** Values a probe runs against: the card's draft, an unsaved key included. */
export interface AdapterProbeDraft {
  /** Endpoint base the form shows. */
  baseUrl: string
  /** API key the form holds. */
  apiKey: string
  /** Model the form shows, when the category configures one. */
  model?: string
}

/**
 * Registry names of the providers this deployment mounted, per category. The
 * Settings page offers them as a row's adapter, so the deployment's own plugin
 * composition — never this package — decides what a row may point at.
 * @param ctx - the plugin context (the media service is optional).
 * @returns one registry-name list per category; every list empty without it.
 */
export function adapterCatalog(ctx: Context): Record<MediaCategory, string[]> {
  const media = ctx.get('media') as MediaRegistryFace | undefined
  if (media === undefined) return { image: [], video: [], music: [] }
  try {
    return {
      image: media.listImageProviders(),
      video: media.listVideoProviders(),
      music: media.listMusicProviders(),
    }
  } catch {
    return { image: [], video: [], music: [] }
  }
}

/**
 * Run the selected adapter's own probe. Every "cannot" — no adapter named, no
 * media service, an adapter this deployment did not mount, a provider without a
 * probe — returns `undefined` so the caller keeps its generic endpoint probe.
 * @param ctx - the plugin context (the media service is optional).
 * @param category - which category's registry to look the adapter up in.
 * @param adapter - the registry name the row names; empty when unset.
 * @param draft - the values the form shows.
 * @returns the probe's outcome, or `undefined` to fall back.
 */
export async function probeViaAdapter(
  ctx: Context,
  category: MediaCategory,
  adapter: string,
  draft: AdapterProbeDraft,
): Promise<{ ok: boolean, message: string } | undefined> {
  if (adapter === '') return undefined
  const media = ctx.get('media') as MediaRegistryFace | undefined
  if (media === undefined) return undefined
  let provider: unknown
  try {
    provider = media[category](adapter)
  } catch {
    // The row names an adapter this deployment did not mount. The generic probe
    // reports the endpoint's answer, and the row stays editable.
    return undefined
  }
  const probe = (provider as Partial<ProviderProbeFace>).probe
  if (typeof probe !== 'function') return undefined
  return await probe.call(provider, draft)
}
