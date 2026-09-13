/**
 * The one asset root: where the library lives, and where a generation lands.
 *
 * Assets are the user's library, not a conversation's by-product — a character
 * design or a poster is reused across projects, and a workspace-scoped tree
 * would fragment that library the moment a session runs somewhere else. The
 * tree therefore lives under the DSH home (`$DSH_HOME/assets`), one root for the
 * user, shared by every profile on the machine.
 *
 * Read and write resolve through this module and nowhere else. Before it, the
 * listing routes read `<process.cwd()>/.assets` while the generation tools wrote
 * `<session cwd>/.assets`, so the two agreed only when a process happened to be
 * started in the session's own workspace — which is exactly what made a desktop
 * install (whose working directory is an install directory, not a workspace)
 * show an empty library.
 *
 * @module @roubaai/media/asset-root
 */

import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Directory name under the DSH home. */
export const ASSETS_DIR_NAME = 'assets'

/** Directory name used when there is no DSH home to anchor to. */
const WORKSPACE_DIR_NAME = '.assets'

/**
 * Environment override, naming the asset directory itself. Tests and a
 * deployment that keeps its library elsewhere set this; nothing in the product
 * sets it, so the DSH home decides by default.
 */
const ROOT_ENV = 'DSH_MEDIA_ASSETS_ROOT'

/** The DSH home holding profiles, skills and this library. */
const HOME_ENV = 'DSH_HOME'

/**
 * Resolve the asset root.
 * @returns the absolute asset directory: `DSH_MEDIA_ASSETS_ROOT`, else
 *   `$DSH_HOME/assets`, else `<cwd>/.assets` for a bare process with no home.
 */
export function assetsRoot(): string {
  const configured = process.env[ROOT_ENV]
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  const home = process.env[HOME_ENV]
  if (home !== undefined && home.trim() !== '') return join(resolve(home), ASSETS_DIR_NAME)
  return join(process.cwd(), WORKSPACE_DIR_NAME)
}

/**
 * The root the reference tunnel serves from, and where staged references are
 * written.
 *
 * A landed asset must remain publishable (`media_reference_url` hands a provider
 * a URL for it), and the tunnel refuses anything outside the root it pinned at
 * startup — so that root has to be at least the asset root's parent. It is the
 * parent exactly when the library is the standard `<home>/assets`; a deployment
 * that points the library somewhere else gets the library itself, so the tunnel
 * can never widen to a whole drive.
 * @returns the absolute directory the tunnel and the staging directory live in.
 */
export function stagingRoot(): string {
  const root = assetsRoot()
  return basename(root) === ASSETS_DIR_NAME ? dirname(root) : root
}

/**
 * Resolve a caller-supplied path inside the asset root, or undefined when it
 * escapes.
 * @param requested - the caller's relative path (empty means the root itself).
 * @returns the absolute path, or undefined when the request is not confined.
 */
export function resolveAssetPath(requested: string): string | undefined {
  if (requested.includes('\0')) return undefined
  const cleaned = requested.replace(/^[\\/]+/, '')
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return undefined
  const root = assetsRoot()
  const prefix = root.endsWith(sep) ? root : root + sep
  const target = resolve(root, cleaned)
  return target === root || target.startsWith(prefix) ? target : undefined
}
