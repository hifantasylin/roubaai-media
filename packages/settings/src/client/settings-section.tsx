/**
 * "RoubaAI" settings section: the per-category provider configuration for the
 * media providers, rendered natively in the DSH Settings shell.
 *
 * Three categories — image, video, music — each render a card list of their
 * providers. Every category carries one built-in default provider whose
 * endpoint and model are read-only; users may add custom providers (endpoint
 * and model editable), switch the provider in use ("使用" turns green
 * "使用中"), and delete custom ones. Writes go through the plugin's own
 * fenced route, never the generic settings RPC.
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
  ROUBAAI_REGISTER_URL,
  resolveRoubaaiMediaSettings,
  type MediaCategory,
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

/** Map one wire failure to an inline message. */
function messageOf(error: unknown): string {
  if (error instanceof RoubaaiApiError && error.code === CONFLICT_CODE) return t('conflict')
  return error instanceof Error ? error.message : String(error)
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
  baseUrl: string
  model: string
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
  const [draft, setDraft] = useState<EditDraft>({ name: '', apiKey: '', baseUrl: '', model: '' })
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)
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
    setDraft({
      name: provider.name,
      apiKey: '',
      // A built-in provider's read-only endpoint/model resolve to the
      // category constants; a custom provider edits its stored overrides.
      baseUrl: provider.custom ? provider.baseUrl : '',
      model: provider.custom ? provider.model : '',
    })
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
  }

  /** Save the edited card: categories wholesale, the key only when typed. */
  const saveEdit = (): void => {
    if (editing === null || busy) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    const { category, providerId } = editing
    const categoryView = settings[category]
    const providers = categoryView.providers.map((entry) => entry.id !== providerId ? entry : {
      ...entry,
      name: draft.name.trim(),
      baseUrl: entry.custom ? draft.baseUrl.trim() : '',
      model: entry.custom ? draft.model.trim() : '',
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
          { id, name: '', custom: true, adapter: MEDIA_CATEGORY_DEFAULT_ADAPTERS[category], baseUrl: '', model: '', apiKey: '' },
        ],
      },
    })
    setEditing({ category, providerId: id })
    setDraft({ name: '', apiKey: '', baseUrl: '', model: '' })
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
    void api.test(base, draft.apiKey, editing.category === 'music' ? 'music' : undefined)
      .then((result) => { setOutcome(result) })
      .catch((caught: unknown) => { setError(`${t('testFailed')}${messageOf(caught)}`) })
      .finally(() => { setBusy(false) })
  }

  /** One labeled field on the editor module: caption above, control below. */
  const field = (props: {
    label: string
    hint?: string
    value: string
    placeholder?: string
    type?: 'text' | 'password'
    onChange?: (next: string) => void
  }): JSX.Element => (
    <div className={css.field}>
      <span className={css.fieldLabel}>{props.label}</span>
      {props.onChange === undefined
        ? props.value === '' ? null : <span className={css.readonlyValue}>{props.value}</span>
        : (
          <input
            className={css.input ?? ''}
            type={props.type ?? 'text'}
            value={props.value}
            {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
            aria-label={props.label}
            onChange={(event) => { props.onChange?.(event.currentTarget.value) }}
          />
        )}
      {props.hint === undefined || props.hint === '' ? null : <p className={css.fieldHint}>{props.hint}</p>}
    </div>
  )

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
            const displayModel = provider.model !== '' ? provider.model : defaults.model
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
                      : (
                        <>
                          {field({ label: t('baseUrlTitle'), hint: t('baseUrlReadonly'), value: '' })}
                          {/* Only the Maizi-backed categories (image/video) key off the
                              registration page; music's built-in endpoint is MxAPI's. */}
                          {category === 'music' ? null : (
                            <a
                              className={css.getApiKey}
                              href={ROUBAAI_REGISTER_URL}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {t('getApiKey')}
                            </a>
                          )}
                        </>
                      )}
                    {provider.custom
                      ? field({
                          label: t('modelTitle'),
                          value: draft.model,
                          placeholder: defaults.model,
                          onChange: (next) => { setDraft((previous) => ({ ...previous, model: next })) },
                        })
                      : field({ label: t('modelTitle'), hint: t('modelReadonly'), value: displayModel })}
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
        <p className={outcome.ok ? css.noticeOk : css.noticeFail} role="status">{outcome.message}</p>
      )}
      {error !== null && (
        <p className={css.noticeFail} role="alert">{error}</p>
      )}
    </div>
  )
}
