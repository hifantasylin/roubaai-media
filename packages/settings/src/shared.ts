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
 * Image and video resolve to Ark (the deployment's own `ARK_API_KEY`, no
 * aggregator in between); music stays on mxapi. A deployment that mounts a
 * different backend set changes these through the Settings page rather than
 * here.
 */
export const MEDIA_CATEGORY_DEFAULT_ADAPTERS: Readonly<Record<MediaCategory, string>> = {
  image: 'ark',
  video: 'ark',
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
 * providers' own runtime constants — and with
 * {@link MEDIA_CATEGORY_DEFAULT_ADAPTERS}, since these are the values the
 * default adapter is expected to accept: a category whose default adapter is
 * Ark cannot carry another vendor's endpoint or model id. Image/video mirror
 * `@roubaai/media-ark`'s `ARK_IMAGE_BASE_URL` / `DEFAULT_IMAGE_MODEL` and
 * `ARK_VIDEO_BASE_URL` / `DEFAULT_VIDEO_MODEL`; music mirrors
 * `@roubaai/media-mxapi`'s `MXAPI_MUSIC_BASE_URL` / `DEFAULT_MUSIC_MODEL`. This
 * copy exists so the browser can display them without a cross-package
 * dependency.
 */
export const MEDIA_CATEGORY_DEFAULTS: Readonly<Record<MediaCategory, CategoryDefaults>> = {
  image: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-5-0-260128' },
  // Seedance 2.0 mini: the 1.5 pro id this used to carry is listed as Retiring
  // by the vendor catalogue, and "mini" is the tier this deployment has always
  // run by default. IDs still move — the picker reads the live catalogue.
  video: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedance-2-0-mini-260615' },
  music: { baseUrl: 'https://open.mxapi.org/api/v2/music', model: 'chirp-bluejay' },
}

/**
 * Resolution tier an image generation runs at when neither the call nor the row
 * names one. Must stay in sync with `@roubaai/media`'s
 * `DEFAULT_IMAGE_RESOLUTION`, which is the copy the tool actually applies; this
 * one exists so the page can label the row's empty choice without importing the
 * media package.
 */
export const MEDIA_IMAGE_DEFAULT_TIER = '2K'

/**
 * One model's capability as the wire reports it, for the model picker to render
 * beside each choice. Structurally identical to `@roubaai/media`'s
 * `MediaModelCapability` — restated here for the same reason the rest of this
 * module is: the browser half must not depend on the media package.
 *
 * Every field but `id` is optional, and an absent field means the backend did
 * not state it, never that the model lacks it. The page therefore renders what
 * it is told and stays silent about the rest rather than guessing a bound the
 * vendor never published.
 */
export interface MediaModelCapabilityView {
  /** The id a request names (matches `MediaModelOption.id`). */
  id: string
  /** Short class label (`pro`, `lite`) when the backend states one. */
  label?: string
  /** Resolution tiers the model accepts, in the backend's own spelling. */
  tiers?: string[]
  /** Pixel floor below which the backend refuses a size. */
  minPixels?: number
  /** Most reference images one request may carry. */
  maxRefImages?: number
  /** Aspect ratios the model accepts. */
  aspectRatios?: string[]
  /** Short Chinese hint the picker shows under the model. */
  note?: string
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
  /**
   * Resolution tier this row prefers; empty uses the category's built-in
   * default. The page only offers tiers the chosen model's capability declares,
   * so this value is one that model can actually serve at the time it was
   * chosen — the tool still re-validates it, because the stored document can
   * outlive the vendor's model list.
   */
  resolution: string
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
 * One media backend this deployment mounted, as the Settings page offers it.
 * The page renders `displayName` and stores `name`: a registry id (`ark`,
 * `maizi`) is a plugin implementation detail, not something to show a person.
 */
export interface AdapterChoice {
  /** Registry name the row's `adapter` field holds. */
  name: string
  /** Human-readable name to render in the adapter picker. */
  displayName: string
  /**
   * Where a person obtains a key for this backend, when that page is known.
   * Absent means "not offered": the page hides the link rather than pointing at
   * an address that may not be the vendor's.
   */
  apiKeyUrl?: string
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
  /**
   * The providers this deployment mounted, per category. The Settings page
   * offers them as a row's adapter and uses their display name and key page; an
   * absent map leaves every row's stored adapter untouched.
   */
  adapters?: Record<MediaCategory, AdapterChoice[]>
}

/**
 * One connection-test result, in three states rather than two.
 *
 * `unconfigured` is not a failure: nobody has supplied a key yet (no form
 * draft, nothing stored, no environment fallback), so nothing was probed. It
 * exists so the page can say that neutrally instead of painting an empty row
 * red — a row that is red for "not filled in yet" teaches the reader to ignore
 * red, which is exactly when a real refusal gets missed.
 */
export interface TestResult {
  /** `ok` — endpoint and key both answered; `unconfigured` — no key anywhere; `failed` — a key exists and the probe failed. */
  status: 'ok' | 'unconfigured' | 'failed'
  /** Human-readable outcome: the status line, or the vendor's own reason. */
  message: string
}

/**
 * One model a backend's catalogue reports, as the configuration form renders
 * it. Structurally identical to `@roubaai/media`'s `MediaModelInfo` — the shape
 * is restated here for the same reason the rest of this module is: the browser
 * half must not depend on the media package.
 */
export interface MediaModelOption {
  /** The id a request names. */
  id: string
  /** Display name when the backend states one. */
  label?: string
  /** Lifecycle state when the backend reports it (e.g. `Retiring`). */
  status?: string
  /** Capability tags the backend reports (Ark's `task_type`). */
  taskTypes?: string[]
  /**
   * What this model accepts — tiers, pixel floor, reference bound — when its
   * backend can state it. Absent means the backend states no capability for
   * that id, which is exactly when the page must not invent a constraint.
   */
  capability?: MediaModelCapabilityView
}

/**
 * One catalogue read. `message` carries an explanation when `models` is empty
 * for a reason other than "the backend has none" — most often that the row's
 * adapter cannot list models at all, in which case the form keeps its free-text
 * model input.
 */
export interface ModelsListResult {
  /** The models the row's backend reported, in the backend's order. */
  models: MediaModelOption[]
  /** Why the list is empty or short, when the host has something to say. */
  message?: string
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
    resolution: UNSET,
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
    resolution: string('resolution'),
    apiKey: keys[id] ?? UNSET,
  }
}
