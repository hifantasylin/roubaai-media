/**
 * Key resolution for both Maizi providers, in one place so the image and video
 * backends can never disagree about where a key comes from.
 *
 * The order matches every backend in this family: the value a person just typed
 * into the form (the most recent statement of intent, and what lets a key be
 * validated before it is stored), then the stored Settings row, then the
 * credential store — and through it the `apiKeyEnv` environment variable.
 *
 * Nothing here ever writes a key anywhere; it only reads the two places a
 * deployment can legitimately put one.
 * @module @roubaai/media-maizi/credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { readActiveMediaProvider } from '@roubaai/media'
import type { MediaSettingsCategory } from '@roubaai/media'

/**
 * Resolve the key an operation should use, or `undefined` when none exists.
 *
 * The `undefined` return is what lets a caller tell "this deployment has no key
 * configured" (a neutral state to show, not a failure) from "a key exists and
 * the backend refused it" (a real failure that needs the vendor's reason).
 * @param ctx - the plugin context (the credential store is optional).
 * @param namespace - the settings namespace the Settings page owns.
 * @param category - which category's active row to read the stored key from.
 * @param apiKeyEnv - the credential reference consulted as the last resort.
 * @param draftKey - a key the configuration form holds but has not saved.
 * @returns the key to present, or `undefined` when nothing is configured.
 */
export async function resolveMaiziKey(
  ctx: Context,
  namespace: string,
  category: MediaSettingsCategory,
  apiKeyEnv: string,
  draftKey = '',
): Promise<string | undefined> {
  const typed = draftKey.trim()
  if (typed !== '') return typed
  const stored = readActiveMediaProvider(ctx, namespace, category).apiKey
  if (stored !== undefined && stored.length > 0) return stored
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(credentialRef(apiKeyEnv))
  return hit !== undefined && hit.value.length > 0 ? hit.value : undefined
}

/**
 * The reason fragment an `unconfigured` probe reports: which sources were
 * consulted and found empty, so the reader knows what to fill in.
 * @param apiKeyEnv - the credential reference that was also consulted.
 * @returns the fragment, meant to follow a "no API key configured" label.
 */
export function maiziUnconfiguredReason(apiKeyEnv: string): string {
  return `表单未填写、设置中未保存，环境变量 ${apiKeyEnv} 也未提供`
}
