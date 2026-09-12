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
import { ROUBAAI_REGISTER_URL } from './shared.ts'
import type {
  AdapterChoice, MediaCategory, MediaModelCapabilityView, MediaModelOption, ModelsListResult, TestResult,
} from './shared.ts'

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
  probe(draft: AdapterProbeDraft): Promise<TestResult>
}

/**
 * A provider's model catalogue, as this module consumes it. Both methods are
 * optional on purpose: a backend with no model-list endpoint simply omits them,
 * and the form keeps its free-text model input.
 */
interface ProviderModelsFace {
  listModels?(signal?: AbortSignal): Promise<MediaModelOption[]>
  listModelsWithDraft?(draft: AdapterProbeDraft, signal?: AbortSignal): Promise<MediaModelOption[]>
}

/**
 * A provider's per-model capability lookup, as this module consumes it.
 * Optional for the same reason the catalogue is: a backend that cannot describe
 * its models leaves every option without a capability, and the page then shows
 * no constraint rather than an invented one.
 */
interface ProviderCapabilityFace {
  capabilities?(model?: string): MediaModelCapabilityView | undefined
}

/**
 * Read one model's capability without letting a failure turn a catalogue read
 * into an error. "This backend cannot describe that model" is a missing label,
 * not a broken page: the model stays selectable and simply carries no facts.
 * @param provider - the provider that owns the catalogue.
 * @param accessor - its capability accessor.
 * @param model - the model id to describe.
 * @returns the capability, or `undefined` when none can be read.
 */
function capabilityOfModel(
  provider: unknown,
  accessor: (model?: string) => MediaModelCapabilityView | undefined,
  model: string,
): MediaModelCapabilityView | undefined {
  try {
    return accessor.call(provider, model) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Attach each listed model's capability to its option, when its backend states
 * one. The enrichment happens here, host-side, because it is the only place
 * that holds a live provider: the browser gets the facts in the same answer as
 * the ids, so a model choice and what that model accepts can never come from
 * two different reads and disagree.
 * @param provider - the provider that owns the catalogue.
 * @param models - the models the provider listed.
 * @returns the options, each carrying its capability when one is stated.
 */
function withCapabilities(provider: unknown, models: readonly MediaModelOption[]): MediaModelOption[] {
  const accessor = (provider as Partial<ProviderCapabilityFace>).capabilities
  if (typeof accessor !== 'function') return [...models]
  return models.map((model) => {
    const capability = capabilityOfModel(provider, accessor, model.id)
    return capability === undefined ? model : { ...model, capability }
  })
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
 * What this page knows about each backend this repository ships: the name to
 * show a person and where that backend issues keys.
 *
 * It lives host-side, next to the catalog, so the browser only renders what it
 * is told — a display name or a key page hardcoded in the client would drift
 * from the registry the moment a backend is added, renamed, or removed. An
 * adapter absent from this table is still offered (the deployment mounted it);
 * it is shown under its registry name with no key link, which is honest rather
 * than a guess.
 *
 * `apiKeyUrl` is a vendor's public console/registration page. It is never a
 * credential and never carries one.
 */
const ADAPTER_DISPLAY: Readonly<Record<string, { displayName: string, apiKeyUrl?: string }>> = {
  ark: {
    displayName: '火山引擎',
    apiKeyUrl: 'https://console.volcengine.com/',
  },
  maizi: {
    displayName: '麦子AI',
    apiKeyUrl: ROUBAAI_REGISTER_URL,
  },
  mxapi: {
    // The music API has no registration page this repository can vouch for, so
    // the row shows no link rather than a URL that may not exist.
    displayName: 'MxAPI',
  },
}

/**
 * The providers this deployment mounted, per category, as display choices. The
 * deployment's own plugin composition — never this package — decides what a row
 * may point at; this only adds the presentation facts.
 * @param ctx - the plugin context (the media service is optional).
 * @returns one choice list per category; every list empty without the service.
 */
export function adapterCatalog(ctx: Context): Record<MediaCategory, AdapterChoice[]> {
  const media = ctx.get('media') as MediaRegistryFace | undefined
  if (media === undefined) return { image: [], video: [], music: [] }
  try {
    return {
      image: media.listImageProviders().map(adapterChoice),
      video: media.listVideoProviders().map(adapterChoice),
      music: media.listMusicProviders().map(adapterChoice),
    }
  } catch {
    return { image: [], video: [], music: [] }
  }
}

/**
 * One registry name as a display choice. An adapter this table does not know
 * keeps its own name as the label: showing a raw id is better than inventing a
 * name for a backend whose vendor this package cannot identify.
 * @param name - the registry name the provider registered itself under.
 * @returns the choice the page renders.
 */
export function adapterChoice(name: string): AdapterChoice {
  const known = ADAPTER_DISPLAY[name]
  return {
    name,
    displayName: known?.displayName ?? name,
    ...known?.apiKeyUrl === undefined ? {} : { apiKeyUrl: known.apiKeyUrl },
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
): Promise<TestResult | undefined> {
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

/**
 * Read the row's backend model catalogue. The row's adapter owns the call
 * because only it knows its own model-list protocol; the draft's endpoint and
 * key are handed over too, so a catalogue can be browsed — and a key validated
 * — before the form is saved.
 *
 * Three outcomes, never a silent empty list:
 *
 *  - the backend implements no catalogue call → an empty list plus a message,
 *    which is how the form learns to keep its free-text model input;
 *  - the adapter is named but this deployment did not mount it → a thrown
 *    error, since the row cannot be served at all;
 *  - the backend's own call failed → its error propagates verbatim, so a
 *    retired key, a denied model, or an unreachable endpoint stays readable
 *    instead of being flattened into "no models".
 *
 * @param ctx - the plugin context (the media service is optional).
 * @param category - which category's registry to look the adapter up in.
 * @param adapter - the registry name the row names; empty when unset.
 * @param draft - the endpoint and key the form holds (an unsaved key included).
 * @param signal - cancellation forwarded to the catalogue call.
 * @returns the catalogue — each model carrying its capability when its backend
 * states one — or an empty list with the reason it is empty.
 * @throws {Error} when no media service or no such mounted adapter exists.
 */
export async function modelsViaAdapter(
  ctx: Context,
  category: MediaCategory,
  adapter: string,
  draft: AdapterProbeDraft,
  signal?: AbortSignal,
): Promise<ModelsListResult> {
  if (adapter === '') {
    throw new Error(`未指定适配器，无法读取${category}模型目录`)
  }
  const media = ctx.get('media') as MediaRegistryFace | undefined
  if (media === undefined) {
    throw new Error('当前部署未挂载媒体服务（ctx.media），无法读取模型目录')
  }
  let provider: unknown
  try {
    provider = media[category](adapter)
  } catch {
    throw new Error(`适配器「${adapter}」未挂载，无法读取模型目录`)
  }
  const face = provider as Partial<ProviderModelsFace>
  if (typeof face.listModelsWithDraft === 'function') {
    const models = await face.listModelsWithDraft.call(provider, draft, signal)
    return { models: withCapabilities(provider, models) }
  }
  if (typeof face.listModels === 'function') {
    const models = await face.listModels.call(provider, signal)
    return { models: withCapabilities(provider, models) }
  }
  return { models: [], message: `适配器「${adapter}」不支持列出模型，请手工填写模型 id。` }
}
