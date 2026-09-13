/**
 * Where assets live: the session's workspace, plus mounted libraries.
 *
 * Assets belong to the project that produced them, so the writable tree is the
 * current session's workspace (`<cwd>/.assets`) — it travels with the project,
 * it sits on whatever drive that project is on, and it cannot quietly fill the
 * system drive. The user-level library (`$DSH_HOME/assets`) stays available as a
 * mount, read-only, for the cross-project case: a character, a style anchor or a
 * piece of music reused by several workspaces.
 *
 * Read and write resolve through this module and nowhere else. Before it, the
 * listing routes read `<process.cwd()>/.assets` while the generation tools wrote
 * `<session cwd>/.assets`, so the two agreed only when a process happened to be
 * started in the session's own workspace — which is why a desktop install
 * (whose working directory is an install directory) showed an empty library.
 *
 * @module @roubaai/media/asset-root
 */

import { isAbsolute, join, resolve, sep } from 'node:path'

/** Directory name under a workspace. */
export const WORKSPACE_DIR_NAME = '.assets'

/** Directory name under the DSH home. */
export const ASSETS_DIR_NAME = 'assets'

/** Environment override naming the user library itself. */
const ROOT_ENV = 'DSH_MEDIA_ASSETS_ROOT'

/** The DSH home holding profiles, skills and the user library. */
const HOME_ENV = 'DSH_HOME'

/** Root id of the writable, session-scoped tree. */
export const WORKSPACE_ROOT_ID = 'workspace'

/** Root id of the mounted user library. */
export const GLOBAL_ROOT_ID = 'global'

/**
 * One tree a request may address.
 *
 * The id is what the wire carries; the label is the client's business, because
 * copy lives in the client's locale dictionary.
 */
export interface AssetRoot {
  /** Opaque id addressing this tree. */
  readonly id: string
  /** Absolute directory. */
  readonly path: string
  /** Whether this tree accepts writes: exactly one root does. */
  readonly writable: boolean
}

/** The trees one request resolves against. */
export interface AssetRoots {
  /** Writes land here, and it is what an unqualified path addresses. */
  readonly primary: AssetRoot
  /** Read-only trees the library also shows. */
  readonly mounts: readonly AssetRoot[]
}

/**
 * The user-level library, overridable for tests and for a deployment that keeps
 * its library elsewhere.
 * @returns the absolute directory of the user library.
 */
export function globalAssetsRoot(): string {
  const configured = process.env[ROOT_ENV]
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  const home = process.env[HOME_ENV]
  if (home !== undefined && home.trim() !== '') return join(resolve(home), ASSETS_DIR_NAME)
  return join(process.cwd(), WORKSPACE_DIR_NAME)
}

/**
 * The tree belonging to one workspace.
 * @param workspace - the session's working directory.
 * @returns `<workspace>/.assets`.
 */
export function workspaceAssetsRoot(workspace: string): string {
  return join(resolve(workspace), WORKSPACE_DIR_NAME)
}

/**
 * The roots a request resolves against.
 *
 * A request that names no workspace (a headless tool call, a stripped host) gets
 * the user library as its writable root, so nothing is unreachable; a request
 * with a workspace gets that workspace's tree plus the library as a mount.
 * @param workspace - the session's working directory, when one is known.
 * @returns the primary root and the mounts.
 */
export function rootsForWorkspace(workspace: string | undefined): AssetRoots {
  const library: AssetRoot = { id: GLOBAL_ROOT_ID, path: globalAssetsRoot(), writable: false }
  if (workspace === undefined || workspace.trim() === '') {
    return { primary: { ...library, writable: true }, mounts: [] }
  }
  return {
    primary: { id: WORKSPACE_ROOT_ID, path: workspaceAssetsRoot(workspace), writable: true },
    mounts: [library],
  }
}

/**
 * The writable root for a caller that knows its workspace and needs no mounts —
 * landing, the cost ledger, and the other host-side writers.
 * @param workspace - the session's working directory, when one is known.
 * @returns the absolute writable root.
 */
export function primaryAssetsRoot(workspace: string | undefined): string {
  return rootsForWorkspace(workspace).primary.path
}

/**
 * Find one root by id.
 * @param roots - the resolved roots.
 * @param id - the requested id, or undefined for the primary.
 * @returns the root, or undefined when the id names none.
 */
export function rootById(roots: AssetRoots, id: string | undefined): AssetRoot | undefined {
  if (id === undefined || id === '') return roots.primary
  if (id === roots.primary.id) return roots.primary
  return roots.mounts.find(root => root.id === id)
}

/**
 * Resolve a caller-supplied path inside one root, or undefined when it escapes.
 * @param root - the root's absolute directory.
 * @param requested - the caller's relative path (empty means the root itself).
 * @returns the absolute path, or undefined when the request is not confined.
 */
export function resolveInRoot(root: string, requested: string): string | undefined {
  if (requested.includes('\0')) return undefined
  const cleaned = requested.replace(/^[\\/]+/, '')
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return undefined
  const prefix = root.endsWith(sep) ? root : root + sep
  const target = resolve(root, cleaned)
  return target === root || target.startsWith(prefix) ? target : undefined
}

/**
 * The workspace a tool call runs in, read from the agent's session header.
 *
 * Structural on purpose: the caller passes whatever it has, and a deployment
 * with no session header gets `undefined` (which resolves to the mounted user
 * library) rather than the host process's own directory.
 * @param agent - the tool call's agent, when it has one.
 * @returns the session's working directory, or undefined when it has none.
 */
export function workspaceOfAgent(agent: { session?: { header?: { cwd?: string } } } | undefined): string | undefined {
  const cwd = agent?.session?.header?.cwd
  return cwd === undefined || cwd === '' ? undefined : cwd
}

/**
 * The directory the reference tunnel serves from, and where staged references
 * are written.
 *
 * A landed asset must remain publishable (`media_reference_url` hands a provider
 * a URL for it), and the tunnel refuses anything outside the root it pinned at
 * startup — so that root has to cover the writable tree. It is the workspace
 * that holds it, not the tree itself, so staged references can stay a sibling
 * rather than a hidden directory inside the library.
 * @param workspace - the session's working directory, when one is known.
 * @returns the absolute directory the tunnel and the staging directory live in.
 */
export function stagingRoot(workspace: string | undefined): string {
  return workspace === undefined || workspace.trim() === '' ? globalAssetsRoot() : resolve(workspace)
}
