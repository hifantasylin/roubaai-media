/**
 * "RoubaAI" settings section: the per-category provider configuration for the
 * media providers, rendered natively in the DSH Settings shell.
 *
 * Three categories — image, video, music — each render a card list of their
 * providers. Every category carries one built-in default provider whose
 * endpoint is read-only; users may add custom providers (endpoint editable),
 * switch the provider in use ("使用" turns green "使用中"), and delete custom
 * ones. Writes go through the plugin's own fenced route, never the generic
 * settings RPC.
 *
 * The model is a choice on EVERY row, built-in included: vendor model ids carry
 * a date segment and retire, so a deployment must be able to move to a current
 * one without turning the built-in row into a custom provider. Its control is a
 * free-text input with the backend's live catalogue under it, read through
 * `models.list` — the catalogue is the vendor's, not a list this plugin ships.
 *
 * Properties the shell depends on:
 *
 *  - API keys are WRITE-ONLY. The route returns a redacted view, so a key
 *    never exists in this component's state after a save; an untouched key
 *    input is omitted from the patch so saving other fields cannot clear it.
 *  - Writes are revision-guarded. The revision the last read returned is sent
 *    back, so a concurrent edit from another surface is refused (and reported)
 *    instead of being silently overwritten.
 *  - A failure is inline. A broken route or a refused write shows a line under
 *    the controls and reverts nothing optimistically — the form never claims a
 *    save it did not make.
 *
 * The markup and styling mirror the models settings section: the same
 * `--dsw-alias-*` theme tokens, the same 14/13/12px type scale, provider row
 * cards that expand into filled editor modules, dense capsule row actions, and
 * a dashed add affordance closing each list.
 * @module @roubaai/settings/client/settings-section
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RoubaaiApiError, api } from './api.ts'
import { t } from './locales.ts'
import {
  DEFAULT_PROVIDER_ID,
  MEDIA_CATEGORIES,
  MEDIA_CATEGORY_DEFAULT_ADAPTERS,
  MEDIA_CATEGORY_DEFAULTS,
  MEDIA_IMAGE_DEFAULT_TIER,
  resolveRoubaaiMediaSettings,
  type AdapterChoice,
  type MediaCategory,
  type MediaModelCapabilityView,
  type MediaModelOption,
  type ResolvedMediaProvider,
  type ResolvedRoubaaiMediaSettings,
  type SettingsView,
  type TestResult,
} from '../shared.ts'
import css from './settings-section.module.css'

/** Full section props: the settings shell's runtime share. */
export type RoubaaiVideoSettingsSectionProps = PropsRuntime<'settings.section'>

/** Wire code of a refused stale write (mirrors the host's mapping). */
const CONFLICT_CODE = 'settings-conflict'

/**
 * A one-row select option: the stored value plus the label a person reads. The
 * adapter picker renders `label` (the host catalog's display name) and stores
 * `value` (the registry name); nothing in the client invents either.
 */
interface SelectOption {
  value: string
  label: string
  /**
   * Rendered unselectable. Used for a value the row already stores that the
   * model's capability no longer lists: it stays visible (an edit must not
   * silently rewrite a choice) but cannot be re-chosen, so it cannot be saved
   * as a fresh pairing.
   */
  disabled?: boolean
}

/**
 * Whether a vendor lifecycle state means "do not pick this for new work". The
 * state stays visible verbatim (it is the vendor's word) and only its tone is
 * softened, because a retiring id is still a valid choice for an existing row.
 */
function isRetiring(status: string | undefined): boolean {
  return status !== undefined && /retir|deprecat|offline|expir|unavailable|停|下线|废弃/i.test(status)
}

/** Map one wire failure to an inline message. */
function messageOf(error: unknown): string {
  if (error instanceof RoubaaiApiError && error.code === CONFLICT_CODE) return t('conflict')
  return error instanceof Error ? error.message : String(error)
}

/**
 * The tone one probe result renders in. Three states, three tones: a row with
 * no key yet is neutral because it is a to-do, a refusal is red because it is a
 * failure, and success is green. Two tones for three states is what made an
 * unconfigured music row look broken.
 */
function outcomeClass(result: TestResult): string {
  switch (result.status) {
    case 'ok': return css.noticeOk ?? ''
    case 'unconfigured': return css.noticeNeutral ?? ''
    default: return css.noticeFail ?? ''
  }
}

/**
 * The line one probe result renders. The state label is localized here and the
 * reason stays verbatim from the backend: a refusal carries the HTTP status and
 * the vendor's own message, which is exactly what the reader needs to act.
 */
function outcomeText(result: TestResult): string {
  switch (result.status) {
    case 'ok': return result.message
    case 'unconfigured': return `${t('probeUnconfigured')}：${result.message}`
    default: return `${t('testFailed')}${result.message}`
  }
}

/** Extract the ids whose API key the redacted view reports as set. */
function keySetIdsOf(view: SettingsView): Set<string> {
  const ids = new Set<string>()
  for (const slot of view.secrets ?? []) {
    if (slot.set && slot.path.length === 2 && slot.path[0] === 'keys') ids.add(slot.path[1]!)
  }
  return ids
}

/** Display name of one provider: the stored name, or the localized default. */
function displayName(provider: ResolvedMediaProvider): string {
  if (provider.name !== '') return provider.name
  return provider.custom ? t('untitledProvider') : t('defaultProviderName')
}

/** One card's local edit draft (the key input is write-only and starts empty). */
interface EditDraft {
  name: string
  apiKey: string
  adapter: string
  baseUrl: string
  model: string
  resolution: string
}

/**
 * Render the provider configuration section.
 * @param _props - the settings shell's runtime share (unused: this section
 * reads its state from the plugin's own route).
 * @returns the section element tree.
 */
export function RoubaaiVideoSettingsSection(_props: RoubaaiVideoSettingsSectionProps): JSX.Element {
  const [settings, setSettings] = useState<ResolvedRoubaaiMediaSettings | null>(null)
  /** Ids whose API key the redacted read reports as stored. */
  const [keySetIds, setKeySetIds] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{ category: MediaCategory; providerId: string } | null>(null)
  const [draft, setDraft] = useState<EditDraft>({ name: '', apiKey: '', baseUrl: '', model: '', adapter: '', resolution: '' })
  /** Adapters this deployment mounted, per category: a row's available choices. */
  const [adapterChoices, setAdapterChoices] = useState<Record<MediaCategory, AdapterChoice[]>>({
    image: [], video: [], music: [],
  })
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)
  /** The edited row's model catalogue, as its backend reported it. */
  const [modelOptions, setModelOptions] = useState<readonly MediaModelOption[]>([])
  /** Why the catalogue is empty or short (a backend that cannot list models). */
  const [modelNote, setModelNote] = useState<string>('')
  /** The picker's filter text: empty shows the whole catalogue. */
  const [modelQuery, setModelQuery] = useState<string>('')
  const [modelListBusy, setModelListBusy] = useState(false)
  const [modelListOpen, setModelListOpen] = useState(false)
  /**
   * Which (row, adapter, endpoint) the loaded catalogue belongs to. A catalogue
   * read is per row and per endpoint, so a list left over from another row must
   * never be offered as if it were this row's.
   */
  const modelListKey = useRef<string>('')
  // The freshest revision, read at commit time: a queued write must observe
  // the previous write's revision, and re-rendering on it is unnecessary.
  const revisionRef = useRef<number | undefined>(undefined)
  /** Providers added locally whose save has not succeeded yet. */
  const unsavedIds = useRef<Set<string>>(new Set())

  /** Adopt one route result: values, revision, and the key slots' state. */
  const adopt = useCallback((view: SettingsView): void => {
    revisionRef.current = view.revision
    setSettings(resolveRoubaaiMediaSettings(view.value))
    setKeySetIds(keySetIdsOf(view))
    setAdapterChoices(view.adapters ?? { image: [], video: [], music: [] })
  }, [])

  // Sync once on mount: another surface may have edited the section since the
  // page loaded, and the revision the first write echoes must be the current
  // one — otherwise that write is refused out of the gate.
  useEffect(() => {
    let cancelled = false
    api.settingsGet()
      .then((view) => { if (!cancelled) adopt(view) })
      .catch((caught: unknown) => { if (!cancelled) setError(messageOf(caught)) })
    return () => { cancelled = true }
  }, [adopt])

  if (settings === null) {
    return (
      <div className={css.section}>
        {error !== null && <p className={css.noticeFail} role="alert">{error}</p>}
      </div>
    )
  }

  /** Send one full-shape patch (categories wholesale, keys sparse-merged). */
  const commit = (patch: Record<string, unknown>): Promise<boolean> =>
    api.settingsUpdate(patch, revisionRef.current)
      .then((view) => {
        adopt(view)
        return true
      })
      .catch((caught: unknown) => {
        setError(messageOf(caught))
        return false
      })
      .finally(() => { setBusy(false) })

  /** Switch the provider one category uses. */
  const useProvider = (category: MediaCategory, providerId: string): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    void commit({ [category]: { activeId: providerId } })
  }

  /** Remove one custom provider; a removed active provider falls back to default. */
  const removeProvider = (category: MediaCategory, providerId: string): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    const categoryView = settings[category]
    const providers = categoryView.providers.filter((entry) => entry.id !== providerId)
    const activeId = categoryView.activeId === providerId
      ? `${DEFAULT_PROVIDER_ID}:${category}`
      : categoryView.activeId
    void commit({ [category]: { activeId, providers } })
  }

  /** Enter edit mode on one provider, seeding the draft from what is shown. */
  const startEdit = (category: MediaCategory, provider: ResolvedMediaProvider): void => {
    setEditing({ category, providerId: provider.id })
    setOutcome(null)
    resetModelCatalogue()
    setDraft({
      name: provider.name,
      apiKey: '',
      adapter: provider.adapter,
      // A built-in provider's read-only endpoint resolves to the category
      // constant; a custom provider edits its stored override. A built-in row
      // resolves to the category default model, which is what its picker shows
      // as the current choice.
      baseUrl: provider.custom ? provider.baseUrl : '',
      model: provider.custom
        ? provider.model
        : provider.model !== '' ? provider.model : MEDIA_CATEGORY_DEFAULTS[category].model,
      resolution: provider.resolution,
    })
  }

  /** Drop any loaded catalogue: it belongs to the row that was being edited. */
  const resetModelCatalogue = (): void => {
    modelListKey.current = ''
    setModelOptions([])
    setModelNote('')
    setModelQuery('')
    setModelListOpen(false)
  }

  /**
   * Read the edited row's model catalogue from its backend. The call carries
   * the card's draft endpoint and key, so a key that has not been saved yet can
   * still browse the catalogue. A backend that cannot list models answers an
   * empty list with a reason, which leaves the free-text input in charge.
   */
  const loadModelCatalogue = (category: MediaCategory, provider: ResolvedMediaProvider, force = false): void => {
    const key = `${category}|${provider.id}|${draft.adapter}|${provider.custom ? draft.baseUrl : ''}`
    if (!force && modelListKey.current === key && (modelOptions.length > 0 || modelNote !== '')) {
      setModelListOpen(true)
      return
    }
    modelListKey.current = key
    setModelListBusy(true)
    setModelListOpen(true)
    void api.modelsList({
      category,
      adapter: draft.adapter,
      draft: {
        // A built-in row's endpoint is read-only; its backend default is what
        // the catalogue must be read from, so an empty draft means "configured".
        baseUrl: provider.custom ? draft.baseUrl : '',
        apiKey: draft.apiKey,
      },
    })
      .then((result) => {
        setModelOptions(result.models)
        setModelNote(result.message ?? (result.models.length === 0 ? t('modelEmpty') : ''))
      })
      .catch((caught: unknown) => {
        setModelOptions([])
        setModelNote(`${t('modelListFailed')}${messageOf(caught)}`)
      })
      .finally(() => { setModelListBusy(false) })
  }

  /**
   * Leave edit mode. A provider added but not yet saved exists only in this
   * component's state, so cancelling drops it — nothing persists until
   * "保存" succeeds.
   */
  const cancelEdit = (): void => {
    if (editing === null) return
    const { category, providerId } = editing
    if (unsavedIds.current.has(providerId)) {
      unsavedIds.current.delete(providerId)
      setSettings((previous) => previous === null ? previous : {
        ...previous,
        [category]: {
          ...previous[category],
          providers: previous[category].providers.filter((entry) => entry.id !== providerId),
        },
      })
    }
    setEditing(null)
    resetModelCatalogue()
  }

  /** Save the edited card: categories wholesale, the key only when typed. */
  const saveEdit = (): void => {
    if (editing === null || busy) return
    const { category, providerId } = editing
    const chosenModel = draft.model.trim()
    const chosenTier = draft.resolution.trim()
    // The page refuses a pairing it can prove impossible: a tier the chosen
    // model's capability does not list. Only a STATED capability can block a
    // save — a backend that reports none, or a catalogue that was never read,
    // leaves the choice to the tool's own call-time check rather than inventing
    // a constraint here.
    const tiers = capabilityOfModel(chosenModel === '' ? MEDIA_CATEGORY_DEFAULTS[category].model : chosenModel)?.tiers
    if (chosenTier !== '' && tiers !== undefined && !tiers.includes(chosenTier)) {
      setError(`${t('tierUnsupported')}${chosenTier}（${t('capTiers')}：${tiers.join(' / ')}）`)
      return
    }
    setBusy(true)
    setError(null)
    setOutcome(null)
    const categoryView = settings[category]
    const defaults = MEDIA_CATEGORY_DEFAULTS[category]
    const providers = categoryView.providers.map((entry) => entry.id !== providerId ? entry : {
      ...entry,
      name: draft.name.trim(),
      // The adapter is the routing choice for every row, built-in included.
      adapter: draft.adapter,
      baseUrl: entry.custom ? draft.baseUrl.trim() : '',
      // The model is a choice even on a built-in row: vendor ids carry dates
      // and retire, so a deployment must be able to move to a current one
      // without turning the built-in row into a custom provider. A built-in row
      // equal to the category default stores nothing, so a later release can
      // move the default without a stale pin overriding it.
      model: entry.custom
        ? chosenModel
        : chosenModel === defaults.model ? '' : chosenModel,
      // The tier is a per-row preference on every row, and deliberately has no
      // "equal to the default stores nothing" rule: the empty choice IS the
      // default, so storing '' and storing the default tier mean the same thing
      // and there is nothing to drop.
      resolution: chosenTier,
    })
    const keysPatch: Record<string, string> = {}
    if (draft.apiKey.trim() !== '') keysPatch[providerId] = draft.apiKey.trim()
    void commit({
      [category]: { providers },
      ...(Object.keys(keysPatch).length === 0 ? {} : { keys: keysPatch }),
    }).then((saved) => {
      // A failed save keeps the editor open with the draft intact; a saved
      // addition is now durable, so cancelling must no longer drop it.
      if (saved) {
        unsavedIds.current.delete(providerId)
        setEditing(null)
        resetModelCatalogue()
      }
    })
  }

  /**
   * Add one custom provider to a category and open it for editing. The entry
   * is LOCAL ONLY until "保存" succeeds: cancelling drops it, and a reload
   * never shows it.
   */
  const addProvider = (category: MediaCategory): void => {
    if (busy) return
    setError(null)
    setOutcome(null)
    const id = `custom:${crypto.randomUUID()}`
    unsavedIds.current.add(id)
    setSettings((previous) => previous === null ? previous : {
      ...previous,
      [category]: {
        ...previous[category],
        providers: [
          ...previous[category].providers,
          // A new card starts on the category's built-in backend; retargeting
          // it at another one is a separate choice the editor owns.
          { id, name: '', custom: true, adapter: MEDIA_CATEGORY_DEFAULT_ADAPTERS[category], baseUrl: '', model: '', resolution: '', apiKey: '' },
        ],
      },
    })
    setEditing({ category, providerId: id })
    resetModelCatalogue()
    setDraft({ name: '', apiKey: '', adapter: MEDIA_CATEGORY_DEFAULT_ADAPTERS[category], baseUrl: '', model: '', resolution: '' })
  }

  /** Probe the edited card's endpoint with its draft key. */
  const testDraft = (): void => {
    if (editing === null || busy) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    const edited = settings[editing.category].providers.find((entry) => entry.id === editing.providerId)
    const defaults = MEDIA_CATEGORY_DEFAULTS[editing.category]
    const custom = edited?.custom === true
    const base = custom && draft.baseUrl.trim() !== '' ? draft.baseUrl.trim() : edited?.baseUrl ?? defaults.baseUrl
    void api.test({
      baseUrl: base,
      apiKey: draft.apiKey,
      category: editing.category,
      // The row's adapter owns the probe, so it must know which backend — and
      // which model — the card is being edited for.
      adapter: draft.adapter,
      model: draft.model.trim() !== '' ? draft.model.trim() : edited?.model ?? defaults.model,
    })
      .then((result) => { setOutcome(result) })
      .catch((caught: unknown) => { setError(`${t('testFailed')}${messageOf(caught)}`) })
      .finally(() => { setBusy(false) })
  }

  /**
   * The adapter choices for one row: what the deployment mounted, plus the
   * row's stored value when it is not among them — editing a row whose adapter
   * plugin is not currently mounted must not silently retarget it. A name the
   * host catalog does not describe is shown as itself: the client never invents
   * a vendor label.
   */
  const adapterOptions = (category: MediaCategory, current: string): SelectOption[] => {
    const choices = adapterChoices[category]
    const options = choices.map((choice) => ({ value: choice.name, label: choice.displayName }))
    if (current !== '' && !options.some((option) => option.value === current)) {
      return [{ value: current, label: current }, ...options]
    }
    return options
  }

  /** The adapter choice the edited row names, for its key page and label. */
  const adapterChoiceOf = (category: MediaCategory, name: string): AdapterChoice | undefined =>
    adapterChoices[category].find((choice) => choice.name === name)

  /**
   * The capability the loaded catalogue states for one model id, when the
   * edited row's backend reported one. An id absent from the catalogue — typed
   * by hand, or listed before this read — answers `undefined`, which the page
   * reads as "not stated" and never as "no constraint".
   * @param model - the model id the row would run.
   * @returns the capability, or `undefined` when none was reported.
   */
  const capabilityOfModel = (model: string): MediaModelCapabilityView | undefined =>
    model.trim() === '' ? undefined : modelOptions.find((option) => option.id === model.trim())?.capability

  /**
   * The facts one model states about itself, as one line: the tiers it accepts
   * (with the pixel floor that usually explains why a smaller tier is missing),
   * how many reference images it carries, and the ratios it accepts. Each part
   * is rendered only when the backend stated it — the page never widens a
   * capability into a constraint of its own making.
   * @param capability - the capability to render.
   * @returns the one-line summary.
   */
  const capabilityLine = (capability: MediaModelCapabilityView): string => {
    const parts: string[] = []
    if (capability.tiers !== undefined) {
      const floor = capability.minPixels === undefined
        ? ''
        : `（≥ ${capability.minPixels.toLocaleString('en-US')} ${t('capPixelsUnit')}）`
      parts.push(`${t('capTiers')}：${capability.tiers.join(' / ')}${floor}`)
    }
    if (capability.maxRefImages !== undefined) parts.push(`${t('capRefs')}：${capability.maxRefImages}`)
    if (capability.aspectRatios !== undefined) parts.push(`${t('capRatios')}：${capability.aspectRatios.join(' / ')}`)
    return parts.join(' · ')
  }

  /**
   * The resolution choices the edited model offers. The list comes from that
   * model's OWN capability, so a pairing the model cannot serve cannot be
   * picked in the first place — this is the whole point of reading capability
   * into the form instead of writing a fixed tier list here.
   *
   * A tier the row already stores but the capability no longer lists stays
   * visible and unselectable, so an edit never silently rewrites a choice; the
   * save path refuses to persist it and says why.
   * @param model - the model the row would run (the category default when the draft names none).
   * @returns the select options, the empty one meaning "follow the model default".
   */
  const tierOptions = (model: string): SelectOption[] => {
    const capability = capabilityOfModel(model)
    const options: SelectOption[] = [{ value: '', label: `${t('tierInherit')}（${MEDIA_IMAGE_DEFAULT_TIER}）` }]
    for (const tier of capability?.tiers ?? []) options.push({ value: tier, label: tier })
    const stored = draft.resolution.trim()
    if (stored !== '' && !options.some((option) => option.value === stored)) {
      options.push({ value: stored, label: `${stored}${t('tierUnsupportedMark')}`, disabled: true })
    }
    return options
  }

  /**
   * Adopt a newly chosen model and keep the tier honest: a tier the new model's
   * capability does not list is dropped back to the default rather than carried
   * along invisibly. An unstated capability drops nothing — there is no basis
   * to correct against.
   * @param category - the row's category.
   * @param model - the model id just chosen or typed.
   */
  const chooseModel = (category: MediaCategory, model: string): void => {
    const effective = model.trim() === '' ? MEDIA_CATEGORY_DEFAULTS[category].model : model.trim()
    const tiers = capabilityOfModel(effective)?.tiers
    setDraft((previous) => previous.resolution !== '' && tiers !== undefined && !tiers.includes(previous.resolution)
      ? { ...previous, model, resolution: '' }
      : { ...previous, model })
  }

  /** The control one field renders: a select over `options`, else a text input. */
  const control = (props: {
    label: string
    value: string
    placeholder?: string
    type?: 'text' | 'password'
    options?: readonly SelectOption[]
    onChange: (next: string) => void
  }): JSX.Element => props.options === undefined
    ? (
      <input
        className={css.input ?? ''}
        type={props.type ?? 'text'}
        value={props.value}
        {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
        aria-label={props.label}
        onChange={(event) => { props.onChange(event.currentTarget.value) }}
      />
    )
    : (
      <select
        className={css.input ?? ''}
        value={props.value}
        aria-label={props.label}
        onChange={(event) => { props.onChange(event.currentTarget.value) }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled === true}>{option.label}</option>
        ))}
      </select>
    )

  /** One labeled field on the editor module: caption above, control below. */
  const field = (props: {
    label: string
    hint?: string
    value: string
    placeholder?: string
    type?: 'text' | 'password'
    /** Render a select over these options instead of a text input. */
    options?: readonly SelectOption[]
    onChange?: (next: string) => void
  }): JSX.Element => (
    <div className={css.field}>
      <span className={css.fieldLabel}>{props.label}</span>
      {props.onChange === undefined
        ? props.value === '' ? null : <span className={css.readonlyValue}>{props.value}</span>
        : control({
          label: props.label,
          value: props.value,
          ...props.placeholder === undefined ? {} : { placeholder: props.placeholder },
          ...props.type === undefined ? {} : { type: props.type },
          ...props.options === undefined ? {} : { options: props.options },
          onChange: props.onChange,
        })}
      {props.hint === undefined || props.hint === '' ? null : <p className={css.fieldHint}>{props.hint}</p>}
    </div>
  )

  /**
   * The model control: a searchable list of the row's backend catalogue sitting
   * under a free-text input, with the chosen model's own capability stated
   * beneath it.
   *
   * The input stays authoritative. Vendor ids carry a date segment and retire,
   * and a catalogue read can fail (no key saved yet, a backend without a
   * model-list endpoint), so a typed id is never rejected and the list is a
   * suggestion that additionally shows each model's lifecycle state and — when
   * its backend states one — the capability that decides which tiers the model
   * can be asked for. The catalogue belongs to the backend, so it is fetched
   * for the current adapter and endpoint rather than cached across rows.
   * @param category - the row's category (which registry serves it).
   * @param provider - the row being edited (adapter, custom flag).
   * @param fallbackModel - the model shown when the row stores none.
   * @returns the model field element tree.
   */
  const modelPicker = (
    category: MediaCategory,
    provider: ResolvedMediaProvider,
    fallbackModel: string,
  ): JSX.Element => {
    const needle = modelQuery.trim().toLowerCase()
    const visible = needle === ''
      ? modelOptions
      : modelOptions.filter((option) =>
          option.id.toLowerCase().includes(needle)
          || (option.label ?? '').toLowerCase().includes(needle))
    const effectiveModel = draft.model.trim() === '' ? fallbackModel : draft.model.trim()
    const capability = capabilityOfModel(effectiveModel)
    return (
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('modelTitle')}</span>
        <input
          className={css.input ?? ''}
          type="text"
          value={draft.model}
          placeholder={fallbackModel}
          aria-label={t('modelTitle')}
          onFocus={() => { loadModelCatalogue(category, provider) }}
          onChange={(event) => {
            const next = event.currentTarget.value
            chooseModel(category, next)
            setModelQuery(next)
            setModelListOpen(true)
          }}
        />
        <div className={css.fieldActions}>
          <button
            type="button"
            className={css.linkButton}
            disabled={modelListBusy}
            onClick={() => { loadModelCatalogue(category, provider, true) }}
          >
            {modelListBusy ? t('modelLoading') : t('modelRefresh')}
          </button>
        </div>
        {modelListOpen && visible.length > 0 && (
          <div className={css.modelOptions}>
            {visible.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`${css.modelOption ?? ''} ${isRetiring(option.status) ? css.modelOptionRetiring ?? '' : ''}`}
                aria-current={option.id === draft.model ? 'true' : undefined}
                onClick={() => {
                  chooseModel(category, option.id)
                  setModelQuery('')
                  setModelListOpen(false)
                }}
              >
                <span className={css.modelOptionId}>{option.label ?? option.id}</span>
                {/* What the model accepts, on the row that offers it: choosing
                    between two ids is a capability decision, so the choice and
                    the facts must not be two separate reads. */}
                {option.capability?.tiers === undefined
                  ? null
                  : <span className={css.modelOptionTiers}>{(option.capability.tiers ?? []).join('/')}</span>}
                {option.status === undefined ? null : <span className={css.modelOptionStatus}>{option.status}</span>}
              </button>
            ))}
          </div>
        )}
        {/* The selected model's capability, stated once it is known. A model
            whose backend reported none shows nothing here rather than a guess. */}
        {capability === undefined ? null : <p className={css.capabilityLine}>{capabilityLine(capability)}</p>}
        {capability?.note === undefined ? null : <p className={css.fieldHint}>{capability.note}</p>}
        {modelNote === '' ? null : <p className={css.fieldHint}>{modelNote}</p>}
        <p className={css.fieldHint}>{t('modelDesc')}</p>
      </div>
    )
  }

  /**
   * The resolution control: a select over the tiers the edited model's own
   * capability declares, so an impossible model/tier pairing cannot be chosen.
   *
   * It appears only when the model states tiers. A backend that reports none
   * keeps the section it has always had — no tier control, no invented
   * constraint — and the empty choice means "follow the default"
   * ({@link MEDIA_IMAGE_DEFAULT_TIER}).
   * @param fallbackModel - the model the row runs when it stores none.
   * @returns the tier field, or `null` when the model states no tiers.
   */
  const tierPicker = (fallbackModel: string): JSX.Element | null => {
    const effectiveModel = draft.model.trim() === '' ? fallbackModel : draft.model.trim()
    const capability = capabilityOfModel(effectiveModel)
    if (capability?.tiers === undefined) return null
    const stored = draft.resolution.trim()
    const stale = stored !== '' && !capability.tiers.includes(stored)
    return (
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('tierTitle')}</span>
        {control({
          label: t('tierTitle'),
          value: draft.resolution,
          options: tierOptions(effectiveModel),
          onChange: (next) => { setDraft((previous) => ({ ...previous, resolution: next })) },
        })}
        {/* A stored tier the model no longer lists: visible so the edit does not
            silently rewrite it, refused at save so it cannot be re-confirmed. */}
        {!stale ? null : <p className={css.noticeFail} role="alert">{`${t('tierUnsupported')}${stored}`}</p>}
        <p className={css.fieldHint}>{t('tierDesc')}</p>
      </div>
    )
  }

  /** One category's provider cards plus its add affordance. */
  const categoryBlock = (category: MediaCategory): JSX.Element => {
    const categoryView = settings[category]
    const defaults = MEDIA_CATEGORY_DEFAULTS[category]
    const heading = category === 'image' ? t('categoryImage')
      : category === 'video' ? t('categoryVideo') : t('categoryMusic')
    return (
      <div className={css.group} key={category}>
        <div className={css.groupHeading}>{heading}</div>
        <div className={css.cards}>
          {categoryView.providers.map((provider) => {
            const active = categoryView.activeId === provider.id
            const isEditing = editing !== null && editing.category === category && editing.providerId === provider.id
            const keySet = keySetIds.has(provider.id)
            const choices = adapterOptions(category, provider.adapter)
            return (
              <div className={css.card} key={provider.id}>
                <div className={css.cardHeader}>
                  <span className={css.cardTitleArea}>
                    <span className={`${css.credentialDot} ${keySet ? css.credentialDotConfigured : css.credentialDotMissing}`} />
                    <span className={css.cardTitle}>{displayName(provider)}</span>
                    {provider.custom && <span className={css.badge}>{t('customBadge')}</span>}
                    {active
                      ? <span className={css.activeLabel}>{t('activeLabel')}</span>
                      : (
                        <button
                          type="button"
                          className={css.linkButton}
                          disabled={busy}
                          onClick={() => { useProvider(category, provider.id) }}
                        >
                          {t('useAction')}
                        </button>
                      )}
                  </span>
                  <span className={css.cardActions}>
                    {!isEditing && (
                      <button
                        type="button"
                        className={css.secondaryButton}
                        disabled={busy}
                        onClick={() => { startEdit(category, provider) }}
                      >
                        {t('editAction')}
                      </button>
                    )}
                    {provider.custom && !isEditing && (
                      <button
                        type="button"
                        className={css.dangerButton}
                        disabled={busy}
                        onClick={() => { removeProvider(category, provider.id) }}
                      >
                        {t('deleteAction')}
                      </button>
                    )}
                  </span>
                </div>
                {isEditing && (
                  <div className={css.cardBody}>
                    {choices.length === 0
                      // Nothing mounted and nothing stored: show the value the
                      // row resolves to rather than an empty select.
                      ? field({ label: t('adapterTitle'), hint: t('adapterHint'), value: provider.adapter })
                      : field({
                          label: t('adapterTitle'),
                          hint: t('adapterHint'),
                          value: draft.adapter,
                          options: choices,
                          onChange: (next) => { setDraft((previous) => ({ ...previous, adapter: next })) },
                        })}
                    {provider.custom && field({
                      label: t('nameTitle'),
                      value: draft.name,
                      placeholder: t('namePlaceholder'),
                      onChange: (next) => { setDraft((previous) => ({ ...previous, name: next })) },
                    })}
                    {field({
                      label: t('apiKeyTitle'),
                      hint: t('apiKeyDesc'),
                      type: 'password',
                      value: draft.apiKey,
                      placeholder: keySet ? t('apiKeySaved') : t('apiKeyUnset'),
                      onChange: (next) => { setDraft((previous) => ({ ...previous, apiKey: next })) },
                    })}
                    {provider.custom
                      ? field({
                          label: t('baseUrlTitle'),
                          value: draft.baseUrl,
                          placeholder: defaults.baseUrl,
                          onChange: (next) => { setDraft((previous) => ({ ...previous, baseUrl: next })) },
                        })
                      : field({ label: t('baseUrlTitle'), hint: t('baseUrlReadonly'), value: '' })}
                    {/* Where this row's backend issues keys. The URL comes from the
                        host catalog, one per adapter: a backend with no page this
                        repository can vouch for shows no link at all rather than a
                        guess at someone else's address. */}
                    {(() => {
                      const choice = adapterChoiceOf(category, draft.adapter)
                      if (choice?.apiKeyUrl === undefined) return null
                      return (
                        <a
                          className={css.getApiKey}
                          href={choice.apiKeyUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {`${t('getApiKey')}（${choice.displayName}）`}
                        </a>
                      )
                    })()}
                    {modelPicker(category, provider, defaults.model)}
                    {tierPicker(defaults.model)}
                    <div className={css.cardFooter}>
                      <button
                        type="button"
                        className={css.secondaryButton}
                        disabled={busy}
                        onClick={cancelEdit}
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        className={css.secondaryButton}
                        disabled={busy}
                        onClick={testDraft}
                      >
                        {busy ? t('testing') : t('test')}
                      </button>
                      <button
                        type="button"
                        className={css.primaryButton}
                        disabled={busy}
                        onClick={saveEdit}
                      >
                        {busy ? t('saving') : t('save')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className={css.addButton}
          disabled={busy}
          onClick={() => { addProvider(category) }}
        >
          + {t('addProvider')}
        </button>
      </div>
    )
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('intro')}</p>
      {MEDIA_CATEGORIES.map((category) => categoryBlock(category))}
      {outcome !== null && (
        <p className={outcomeClass(outcome)} role="status">{outcomeText(outcome)}</p>
      )}
      {error !== null && (
        <p className={css.noticeFail} role="alert">{error}</p>
      )}
    </div>
  )
}
