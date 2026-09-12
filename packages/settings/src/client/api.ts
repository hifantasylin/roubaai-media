/**
 * Typed `fetch` wrapper over the plugin's fenced JSON route. Every call posts
 * to `<API_PREFIX>/<method>` and returns the envelope's `value`; a non-ok
 * envelope or a transport failure surfaces as {@link RoubaaiApiError} carrying
 * the wire code, so the settings surface can show the reason inline instead of
 * failing silently.
 * @module @roubaai/settings/client/api
 */

import type { MediaCategory, SettingsView, TestResult } from '../shared.ts'

/** The host route prefix (kept in sync with the host half's `API_PREFIX`). */
export const API_PREFIX = '/api/roubaai-video'

/** One wire failure. */
export class RoubaaiApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RoubaaiApiError'
  }
}

/**
 * Post one method and unwrap its value.
 * @param method - the route method name (`settings.get`, `test`, …).
 * @param payload - the JSON body.
 * @returns the envelope's `value`.
 */
async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_PREFIX}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new RoubaaiApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null =
    await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new RoubaaiApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${String(response.status)}`,
    )
  }
  return parsed.value as T
}

/** The route surface used by the settings section. */
export const api = {
  /** Read the redacted configuration and its revision. */
  settingsGet: (): Promise<SettingsView> =>
    call<SettingsView>('settings.get', {}),
  /**
   * Merge a patch into the configuration.
   * @param patch - partial settings (a `secret` field is written, never read back here).
   * @param expectedRevision - the revision the caller read; a namespace that
   * moved past it is refused so a concurrent edit is never overwritten.
   */
  settingsUpdate: (patch: Record<string, unknown>, expectedRevision?: number): Promise<SettingsView> =>
    call<SettingsView>('settings.update', {
      patch,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    }),
  /**
   * Probe one endpoint with one key — the values the caller is looking at, an
   * unsaved key included. Nothing is persisted by this call.
   * @param draft - the endpoint, key, category, adapter, and model the card shows.
   * @returns the probe's outcome.
   */
  test: (draft: {
    baseUrl: string
    apiKey: string
    category: MediaCategory
    adapter?: string
    model?: string
  }): Promise<TestResult> =>
    call<TestResult>('test', {
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      kind: draft.category,
      ...draft.adapter === undefined || draft.adapter === '' ? {} : { adapter: draft.adapter },
      ...draft.model === undefined || draft.model === '' ? {} : { model: draft.model },
    }),
}
