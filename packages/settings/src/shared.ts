/**
 * Dependency-free half of the plugin's configuration contract: the namespace
 * id, the per-category provider settings shape, and the wire view the fenced
 * route returns.
 *
 * This module exists so the CLIENT bundle can import the contract without
 * pulling in `schemastery` — a schema library is a host-side concern and has
 * no business in a browser bundle (`verify-client-bundle-purity` refuses it).
 * `config.ts` layers the schema on top of this file; the browser half imports
 * only this one.
 *
 * Structure: three categories (image / video / music), each holding a
 * provider list plus the id of the provider currently in use. Every category
 * carries one built-in default provider (`id: 'default'`) whose endpoint and
 * model are fixed by this module's constants; users may add custom providers
 * and switch the active one. API keys live OUTSIDE the per-category trees in
 * one top-level `keys` dict (`providerId -> key`) so the wire redaction has a
 * flat secret surface and a deep-merge patch can update one key without
 * restating the others.
 * @module @roubaai/settings/shared
 */

/** The user-settings namespace holding the provider configuration. */
export const ROUBAAI_SETTINGS_NS = 'roubaai-video-plugin'

/** Empty string means "unset": the consumer falls back to its own default. */
export const UNSET = ''

/** One media category the settings page manages. */
export type MediaCategory = 'image' | 'video' | 'music'

/** All categories, in display order. */
export const MEDIA_CATEGORIES: readonly MediaCategory[] = ['image', 'video', 'music']

/** The built-in provider id every category is seeded with. */
export const DEFAULT_PROVIDER_ID = 'default'

/**
 * Registry name of the provider each category falls back to when an entry
 * carries no adapter: the backend an unconfigured deployment has always used.
 * A deployment that mounts a different backend set changes these through the
 * Settings page rather than here.
 */
export const MEDIA_CATEGORY_DEFAULT_ADAPTERS: Readonly<Record<MediaCategory, string>> = {
  image: 'maizi',
  video: 'maizi',
  music: 'mxapi',
}

/** Registration page the built-in image/video providers' key comes from. */
export const ROUBAAI_REGISTER_URL = 'https://www.maizitech.net/register?invite_code=664KPT'

/** Built-in defaults one category falls back to when its entry leaves a field empty. */
export interface CategoryDefaults {
  /** Endpoint base used when the provider entry carries no override. */
  readonly baseUrl: string
  /** Model id used when the provider entry carries no override. */
  readonly model: string
}

/**
 * Built-in per-category endpoint/model defaults. Must stay in sync with the
 * providers' own runtime constants (`@roubaai/media-maizi`'s
 * `MAIZI_*_BASE_URL` / `DEFAULT_*_MODEL` and `@roubaai/media-mxapi`'s
 * `MXAPI_MUSIC_BASE_URL` / `DEFAULT_MUSIC_MODEL`) — this copy exists so the
 * browser can display them without a cross-package dependency.
 */
export const MEDIA_CATEGORY_DEFAULTS: Readonly<Record<MediaCategory, CategoryDefaults>> = {
  image: { baseUrl: 'https://www.maizitech.xyz/v1', model: 'gpt-image-2' },
  video: { baseUrl: 'https://www.maizitech.xyz/v1', model: 'doubao-seedance-2.0-mini' },
  music: { baseUrl: 'https://open.mxapi.org/api/v2/music', model: 'chirp-bluejay' },
}

/** One provider configuration inside a category (API key excluded; see `keys`). */
export interface MediaProviderEntry {
  /** Stable unique id (across categories): `'default'` or a generated id. */
  id: string
  /** Display name; empty renders the localized default-provider label. */
  name: string
  /** Whether this is a user-added custom provider (endpoint/model editable). */
  custom: boolean
  /**
   * Registry name of the provider that serves this entry. `@roubaai/media`
   * resolves an operation's provider by this name, so several entries may
   * target different backends while only the active one runs. Empty resolves to
   * the category's built-in adapter; the display name is `name`, never this.
   */
  adapter: string
  /** Endpoint base override; empty uses the category's built-in default. */
  baseUrl: string
  /** Model id override; empty uses the category's built-in default. */
  model: string
}

/** One category's provider list plus the provider currently in use. */
export interface MediaCategorySettings {
  /** Id of the provider in use; must exist in `providers`. */
  activeId: string
  /** The category's providers; always contains the built-in default. */
  providers: MediaProviderEntry[]
}

/** The stored shape of the whole namespace (API keys live in `keys`). */
export interface RoubaaiMediaSettings {
  image: MediaCategorySettings
  video: MediaCategorySettings
  music: MediaCategorySettings
}

/** One fully-resolved provider: the entry plus its API key ('' when unset). */
export interface ResolvedMediaProvider extends MediaProviderEntry {
  apiKey: string
}

/** One category resolved for consumption/display. */
export interface ResolvedMediaCategory extends MediaCategorySettings {
  providers: ResolvedMediaProvider[]
}

/** Fully-resolved settings (every field present). */
export interface ResolvedRoubaaiMediaSettings {
  image: ResolvedMediaCategory
  video: ResolvedMediaCategory
  music: ResolvedMediaCategory
  /** providerId -> API key ('' when unset). */
  keys: Record<string, string>
}

/** One schema-declared secret slot, as the redacted descriptor reports it. */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/**
 * The view the fenced route returns for a read or a write: the redacted value
 * (`keys` values absent), the revision a following write must echo, and the
 * secret slots so the form can show "已保存" without ever receiving a key.
 */
export interface SettingsView {
  /** Redacted resolved value. */
  value: unknown
  /** Monotonic revision of the user section; echo it on the next write. */
  revision?: number
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[]
}

/** One connection-test result. */
export interface TestResult {
  /** Whether the endpoint answered and accepted the key. */
  ok: boolean
  /** Human-readable outcome (status, or why the probe failed). */
  message: string
}

/** Build the built-in default provider entry for one category. */
export function defaultProviderEntry(category: MediaCategory): MediaProviderEntry {
  return {
    id: `${DEFAULT_PROVIDER_ID}:${category}`,
    name: '',
    custom: false,
    adapter: MEDIA_CATEGORY_DEFAULT_ADAPTERS[category],
    baseUrl: UNSET,
    model: UNSET,
  }
}

/**
 * Narrow one untrusted value into the fully-resolved shape. A namespace the
 * schema has already validated still needs this: redaction strips the `keys`
 * values, an old document may miss fields, and every consumer would rather
 * read '' than branch on `undefined`. Guarantees: each category exists, its
 * `providers` contains the built-in default, `activeId` points at an existing
 * provider, and `keys` maps ids to strings.
 * @param value - the resolved namespace value (untrusted shape).
 * @returns every field present as strings.
 */
export function resolveRoubaaiMediaSettings(value: unknown): ResolvedRoubaaiMediaSettings {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const keys = normalizeKeys(source['keys'])
  const categories = {} as ResolvedRoubaaiMediaSettings
  for (const category of MEDIA_CATEGORIES) {
    categories[category] = resolveCategory(source[category], category, keys)
  }
  return categories
}

/** Normalize the secret dict: keep string entries only. */
function normalizeKeys(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[id] = entry
  }
  return out
}

/** Resolve one category: seed the default entry and validate `activeId`. */
function resolveCategory(value: unknown, category: MediaCategory, keys: Record<string, string>): ResolvedMediaCategory {
  const defaults = MEDIA_CATEGORY_DEFAULTS[category]
  const builtIn = defaultProviderEntry(category)
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const rawProviders = Array.isArray(source['providers']) ? source['providers'] : []
  const providers: ResolvedMediaProvider[] = []
  for (const raw of rawProviders) {
    const entry = resolveEntry(raw, keys, category)
    if (entry !== undefined && !providers.some((existing) => existing.id === entry.id)) {
      providers.push(entry)
    }
  }
  if (!providers.some((entry) => entry.id === builtIn.id)) {
    providers.unshift({ ...builtIn, apiKey: keys[builtIn.id] ?? UNSET })
  }
  const activeId = typeof source['activeId'] === 'string' && providers.some((entry) => entry.id === source['activeId'])
    ? source['activeId']
    : providers[0]!.id
  // A built-in provider's empty endpoint/model resolve to the category's
  // built-in constants so consumers and the display agree on what runs.
  for (const entry of providers) {
    if (!entry.custom) {
      entry.baseUrl = entry.baseUrl === UNSET ? defaults.baseUrl : entry.baseUrl
      entry.model = entry.model === UNSET ? defaults.model : entry.model
    }
  }
  return { activeId, providers }
}

/** Narrow one provider entry; `undefined` rejects a non-object row. */
function resolveEntry(
  value: unknown,
  keys: Record<string, string>,
  category: MediaCategory,
): ResolvedMediaProvider | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' && record['id'].length > 0 ? record['id'] : undefined
  if (id === undefined) return undefined
  const string = (key: string): string => typeof record[key] === 'string' ? record[key] as string : UNSET
  const adapter = string('adapter')
  return {
    id,
    name: string('name'),
    custom: record['custom'] === true,
    // An entry stored before adapters existed carries none; it resolves to the
    // category default, which is the backend such a document has always run.
    adapter: adapter === UNSET ? MEDIA_CATEGORY_DEFAULT_ADAPTERS[category] : adapter,
    baseUrl: string('baseUrl'),
    model: string('model'),
    apiKey: keys[id] ?? UNSET,
  }
}
