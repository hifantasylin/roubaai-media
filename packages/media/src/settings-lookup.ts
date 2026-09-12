/**
 * Bridge from the roubaai settings page to the media providers: resolve which
 * provider one category currently routes to, plus that provider's API key,
 * endpoint base, default model, and default resolution tier, out of the
 * settings namespace the `@roubaai/settings` page owns.
 *
 * The page stores one row per configured backend and marks one of them active.
 * A row's `adapter` is the registry name of the provider that serves it, so the
 * tools resolve the provider by adapter rather than taking whichever one
 * happens to be registered first — several backends may be mounted at once.
 *
 * Reads are PER OPERATION and OPTIONAL in every direction: a deployment without
 * the settings service, without the plugin, or with an unreadable document
 * falls straight through to `undefined`, and the caller keeps its registry
 * default. That is why the service is reached through `ctx.get` rather than an
 * `inject` entry — providers must keep loading on surfaces that carry no
 * settings service.
 *
 * The built-in fallbacks mirror the providers' own runtime constants
 * (`@roubaai/media-ark` for image/video, `@roubaai/media-mxapi` for music); the
 * settings page's browser half carries a synced copy so its display agrees with
 * what runs.
 * @module @roubaai/media/settings-lookup
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Settings namespace holding the provider configuration. `@roubaai/settings`
 * owns the stored shape; this id is the shared data contract between the page
 * and the media tools, so it stays fixed across package renames.
 */
export const MEDIA_SETTINGS_NAMESPACE = 'roubaai-video-plugin'

/** One media category the settings page manages. */
export type MediaSettingsCategory = 'image' | 'video' | 'music'

/** One provider configuration as the providers consume it. */
export interface ActiveMediaProvider {
  /** The provider in use's API key; absent when unset (callers fall back). */
  apiKey?: string
  /** Endpoint base override from the settings page; absent when unset. */
  baseUrl?: string
  /** Default model override from the settings page; absent when unset. */
  model?: string
  /**
   * Default resolution tier from the settings page; absent when unset. The
   * page only offers tiers the chosen model's capability declares, so a value
   * that reaches here is one that model can serve — the tool still validates
   * it, because a document can be older than the vendor's model list.
   */
  resolution?: string
}

/** Minimal structural face of the settings service this module consumes. */
interface SettingsDescriptorFace {
  describe(): readonly { ns: string; value: unknown }[]
}

/** The namespace document as this module reads it (untrusted, partial). */
interface ActiveEntryLookup {
  /** The active row as stored, or undefined when none matches. */
  entry: Record<string, unknown> | undefined
  /** Top-level providerId -> API key map. */
  keys: Record<string, unknown>
  /**
   * Id the active row is keyed by in `keys`: the stored `activeId` when a row
   * carries it, the fallback row's own id when it does not, and the settings
   * page's built-in id when the category has no rows at all.
   */
  activeId: string
}

/** Read one non-empty string, else ''. */
function string(entry: unknown): string {
  return typeof entry === 'string' && entry.length > 0 ? entry : ''
}

/**
 * Locate the active row of one category in the settings document. Every failure
 * — no settings service, no namespace, a throwing descriptor, a malformed
 * document — resolves to an absent entry, which callers read as "unconfigured".
 *
 * The fallback matters: the schema defaults `activeId` to `'default'` while a
 * built-in row's id is `'default:<category>'`, and the legacy migration writes
 * exactly that bare `'default'`. An `activeId` matching no row therefore reaches
 * here in ordinary stored documents, and treating it as "no configuration at
 * all" silently drops the category's key, endpoint, and model — the call then
 * falls through to a different backend's defaults with nothing to show for it.
 * The first row is the row a person sees selected on the Settings page, so it
 * is the right resolution; nothing has to be re-saved for it to take effect.
 * @param ctx - the plugin context (the settings service is optional).
 * @param namespace - the settings namespace the settings page owns.
 * @param category - which category's active row to locate.
 * @returns the active row, the key map, and the resolved active id.
 */
function lookupActiveEntry(ctx: Context, namespace: string, category: MediaSettingsCategory): ActiveEntryLookup {
  const settings = ctx.get('settings') as SettingsDescriptorFace | undefined
  if (settings === undefined) return { entry: undefined, keys: {}, activeId: '' }
  let value: unknown
  try {
    value = settings.describe().find((descriptor) => descriptor.ns === namespace)?.value
  } catch {
    return { entry: undefined, keys: {}, activeId: '' }
  }
  if (typeof value !== 'object' || value === null) return { entry: undefined, keys: {}, activeId: '' }
  const record = value as Record<string, unknown>
  const categoryValue = typeof record[category] === 'object' && record[category] !== null
    ? record[category] as Record<string, unknown>
    : undefined
  const keys = typeof record['keys'] === 'object' && record['keys'] !== null
    ? record['keys'] as Record<string, unknown>
    : {}
  const configuredId = string(categoryValue?.['activeId'])
  const providers = Array.isArray(categoryValue?.['providers']) ? categoryValue['providers'] : []
  for (const candidate of providers) {
    if (isRow(candidate) && candidate['id'] === (configuredId === '' ? `default:${category}` : configuredId)) {
      return { entry: candidate, keys, activeId: candidate['id'] as string }
    }
  }
  // No row carries the configured id (or none was stored at all). Fall back to
  // the category's first row, and keep its own id as the key-map key so a key
  // stored against that row still resolves.
  for (const candidate of providers) {
    if (isRow(candidate)) return { entry: candidate, keys, activeId: candidate['id'] as string }
  }
  // No rows at all: keep the historical id so a key stored for the built-in
  // row still resolves, even though the row itself is absent.
  return { entry: undefined, keys, activeId: configuredId === '' ? `default:${category}` : configuredId }
}

/** Whether a stored provider entry is an object carrying a non-empty string id. */
function isRow(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const id = (value as Record<string, unknown>)['id']
  return typeof id === 'string' && id.length > 0
}

/**
 * Resolve the provider one category currently uses. Overrides come back
 * absent when unset, so each consumer keeps its own fallback priority
 * (settings page → deployment config → built-in default).
 * @param ctx - the plugin context (the settings service is optional).
 * @param namespace - the settings namespace the settings page owns.
 * @param category - which category's active provider to resolve.
 * @returns the key and overrides; every field absent when unconfigured.
 */
export function readActiveMediaProvider(
  ctx: Context,
  namespace: string,
  category: MediaSettingsCategory,
): ActiveMediaProvider {
  const { entry, keys, activeId } = lookupActiveEntry(ctx, namespace, category)
  const apiKey = string(keys[activeId])
  const baseUrl = string(entry?.['baseUrl'])
  const model = string(entry?.['model'])
  const resolution = string(entry?.['resolution'])
  return {
    ...(apiKey === '' ? {} : { apiKey }),
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(model === '' ? {} : { model }),
    ...(resolution === '' ? {} : { resolution }),
  }
}

/**
 * Registry name of the provider the settings page routes one category to, or
 * `undefined` when nothing selects one — no settings service, no namespace, or
 * a row stored before adapters existed. Callers resolve `undefined` to the
 * registry default, which is the backend an unconfigured deployment has always
 * used.
 * @param ctx - the plugin context (the settings service is optional).
 * @param category - which category's active adapter to resolve.
 * @param namespace - the settings namespace the settings page owns.
 * @returns the adapter's registry name, or `undefined` when none is configured.
 */
export function readActiveAdapter(
  ctx: Context,
  category: MediaSettingsCategory,
  namespace: string = MEDIA_SETTINGS_NAMESPACE,
): string | undefined {
  const { entry } = lookupActiveEntry(ctx, namespace, category)
  const adapter = string(entry?.['adapter'])
  return adapter === '' ? undefined : adapter
}
