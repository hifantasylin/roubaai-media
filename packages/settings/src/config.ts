/**
 * Serializable configuration for the roubaai video plugin: the user-facing
 * provider settings a deployment edits on the Settings page (per-category
 * providers with API keys, endpoints, and models) rather than through
 * environment variables or the process-wide credential store.
 *
 * The schema is the SINGLE source of truth for three consumers: the settings
 * namespace registration (which validates and resolves defaults), the
 * configuration surface (which renders the provider cards, secret slots as
 * write-only inputs), and the media providers (which read the resolved value
 * before falling back to credentials/env).
 *
 * The dependency-free half of the contract lives in `shared.ts` so the browser
 * bundle imports the shape without the schema library; this file layers the
 * schemastery schema on top and re-exports the rest unchanged.
 *
 * API keys live in one top-level `keys` dict (`providerId -> key`) instead of
 * inside the per-category provider rows: the redaction walker strips dict
 * entries and reports each as a secret slot, and a deep-merge patch can update
 * one key without restating — or erasing — the others.
 * @module @roubaai/settings/config
 */

import z from '@deepseek-ai/schemastery'
import { UNSET } from './shared.ts'
import type {
  MediaCategorySettings, MediaProviderEntry, RoubaaiMediaSettings,
} from './shared.ts'

export * from './shared.ts'

/** Schema for one provider row (API key excluded; it lives in `keys`). */
const MediaProviderEntrySchema: z<MediaProviderEntry> = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  custom: z.boolean().default(false),
  baseUrl: z.string().default(UNSET),
  model: z.string().default(UNSET),
})

/** Schema for one category: its provider list plus the provider in use. */
const MediaCategorySettingsSchema: z<MediaCategorySettings> = z.object({
  activeId: z.string().default('default'),
  providers: z.array(MediaProviderEntrySchema).default([]),
})

/**
 * Schemastery schema for the whole namespace.
 *
 * `keys` maps provider ids to their API keys; every entry carries
 * `role('secret')`, so the settings service strips the values from every
 * `describe({ redactSecrets: true })` response and reports only whether each
 * slot is set — the keys are write-only from the browser's point of view.
 * A deep-merge patch over `keys` updates one provider's key without touching
 * the others (objects merge recursively; arrays never appear here).
 */
export const RoubaaiMediaSettingsSchema: z<RoubaaiMediaSettings> = z.object({
  image: MediaCategorySettingsSchema.default({ activeId: 'default', providers: [] }),
  video: MediaCategorySettingsSchema.default({ activeId: 'default', providers: [] }),
  music: MediaCategorySettingsSchema.default({ activeId: 'default', providers: [] }),
  keys: z.dict(z.string().role('secret').default('')).default({}),
})