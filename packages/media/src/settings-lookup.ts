/**
 * Bridge from the roubaai settings page to the media providers: resolve the
 * provider one category currently uses (its API key, endpoint base, and
 * default model) out of the settings namespace the `@roubaai/settings` page
 * owns.
 *
 * Reads are PER OPERATION and OPTIONAL in every direction: a deployment
 * without the settings service, without the plugin, or with an unreadable
 * document falls straight through to the built-in category defaults (endpoint
 * and model) and lets the caller continue to its credential store and
 * environment. That is why the service is reached through `ctx.get` rather
 * than an `inject` entry — providers must keep loading on surfaces that carry
 * no settings service.
 *
 * The built-in fallbacks mirror the providers' own runtime constants
 * (`@roubaai/media-maizi` and `@roubaai/media-mxapi`); the settings page's
 * browser half carries a synced copy so its display agrees with what runs.
 * @module @roubaai/media/settings-lookup
 */

import type { Context } from '@deepseek-ai/cordis'

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
}

/** Minimal structural face of the settings service this module consumes. */
interface SettingsDescriptorFace {
  describe(): readonly { ns: string; value: unknown }[]
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
  const settings = ctx.get('settings') as SettingsDescriptorFace | undefined
  if (settings === undefined) return {}
  let value: unknown
  try {
    value = settings.describe().find((descriptor) => descriptor.ns === namespace)?.value
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const categoryValue = typeof record[category] === 'object' && record[category] !== null
    ? record[category] as Record<string, unknown>
    : undefined
  const keys = typeof record['keys'] === 'object' && record['keys'] !== null
    ? record['keys'] as Record<string, unknown>
    : {}
  const string = (entry: unknown): string =>
    typeof entry === 'string' && entry.length > 0 ? entry : ''
  const providers = Array.isArray(categoryValue?.['providers']) ? categoryValue['providers'] : []
  const activeId = string(categoryValue?.['activeId']) || `default:${category}`
  let entry: Record<string, unknown> | undefined
  for (const candidate of providers) {
    if (typeof candidate === 'object' && candidate !== null
      && (candidate as Record<string, unknown>)['id'] === activeId) {
      entry = candidate as Record<string, unknown>
      break
    }
  }
  const apiKey = string(keys[activeId])
  const baseUrl = string(entry?.['baseUrl'])
  const model = string(entry?.['model'])
  return {
    ...(apiKey === '' ? {} : { apiKey }),
    ...(baseUrl === '' ? {} : { baseUrl }),
    ...(model === '' ? {} : { model }),
  }
}
