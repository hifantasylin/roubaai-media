/**
 * The settings namespace the roubaai video plugin's Settings page owns. The
 * actual per-operation read of the active provider (key, endpoint, model) now
 * lives in `@roubaai/media`'s `readActiveMediaProvider`, which both this
 * package and `@roubaai/media-mxapi` consume.
 * @module @roubaai/media-maizi/settings-config
 */

/** Namespace the roubaai video plugin's Settings page owns. */
export const DEFAULT_SETTINGS_NAMESPACE = 'roubaai-video-plugin'
