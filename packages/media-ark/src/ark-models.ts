/**
 * Ark's model catalogue: the read side of `GET {base}/models`, shared by the
 * video and image providers because both need the same two things — a live list
 * of what may be requested, and a recovery hint to attach when Ark refuses a
 * model id it no longer serves.
 *
 * Model ids are the reason this module exists at all. Ark ids embed a release
 * or date segment (`doubao-seedance-2-0-260128`, `doubao-seedream-5-0-pro-260628`)
 * and Ark retires them on its own schedule, so a hardcoded id is a promise the
 * vendor never made. Asking Ark is the only sound answer, and it is also what
 * turns an opaque `InvalidEndpointOrModel.NotFound` into a usable next step.
 * @module @roubaai/media-ark/ark-models
 */

import type { MediaModelInfo } from '@roubaai/media'
import { ArkHttpError, getJson } from './http.ts'

/** Which entries of the catalogue one caller wants. */
export interface ArkModelFilter {
  /** Keep an entry whose `task_type` contains this fragment (e.g. `Video`). */
  taskType?: string
  /** Keep an entry whose id contains this fragment (e.g. `seedream`). */
  idIncludes?: string
}

/** Narrow an untrusted value to a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one `task_type` field. Ark reports the capability either as a bare
 * string or as a list; both shapes reach this module, so both normalize to a
 * non-empty string list.
 */
function taskTypesOf(value: unknown): string[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/**
 * Parse the `GET /models` payload into the seam's model list. The endpoint
 * answers `{ object: 'list', data: [...] }`; a bare array is accepted too, since
 * a gateway in front of Ark may unwrap it. An entry without a usable id is
 * dropped rather than surfaced as an unrequestable row.
 * @param data - the parsed response body (untrusted).
 * @returns one entry per model Ark reported, in Ark's own order.
 */
export function parseArkModels(data: unknown): MediaModelInfo[] {
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data['data'])
      ? data['data']
      : []
  const models: MediaModelInfo[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = row['id']
    if (typeof id !== 'string' || id.length === 0) continue
    const label = typeof row['name'] === 'string' && row['name'].length > 0 ? row['name'] : undefined
    const status = typeof row['status'] === 'string' && row['status'].length > 0 ? row['status'] : undefined
    const taskTypes = taskTypesOf(row['task_type'])
    models.push({
      id,
      ...label === undefined ? {} : { label },
      ...status === undefined ? {} : { status },
      ...taskTypes.length === 0 ? {} : { taskTypes },
    })
  }
  return models
}

/**
 * Keep the entries one provider can actually serve. An entry Ark reports
 * without a `task_type` is kept when only an id fragment is asked for, and
 * dropped when a capability is asked for — an unlabelled row cannot be shown to
 * be the kind wanted, and offering it would send a request Ark rejects.
 * @param models - the parsed catalogue.
 * @param filter - which entries to keep; an empty filter keeps everything.
 * @returns the matching entries, in input order.
 */
export function filterArkModels(models: readonly MediaModelInfo[], filter: ArkModelFilter): MediaModelInfo[] {
  const taskType = filter.taskType?.toLowerCase()
  const idIncludes = filter.idIncludes?.toLowerCase()
  return models.filter((model) => {
    if (idIncludes !== undefined && !model.id.toLowerCase().includes(idIncludes)) return false
    if (taskType === undefined) return true
    return (model.taskTypes ?? []).some((entry) => entry.toLowerCase().includes(taskType))
  })
}

/**
 * Fetch and filter Ark's catalogue. A non-200 is raised rather than swallowed:
 * "the backend could not be asked" must stay distinguishable from "the backend
 * offers nothing".
 * @param baseUrl - the resolved endpoint base (no trailing slash).
 * @param apiKey - the Ark API key to present.
 * @param filter - which entries to keep.
 * @param signal - cancellation forwarded to the request.
 * @returns the matching models.
 * @throws {ArkHttpError} when Ark answers a non-200.
 */
export async function fetchArkModels(
  baseUrl: string,
  apiKey: string,
  filter: ArkModelFilter,
  signal?: AbortSignal,
): Promise<MediaModelInfo[]> {
  const { status, data } = await getJson(`${baseUrl}/models`, apiKey, signal)
  if (status !== 200) {
    throw new ArkHttpError(`Ark model list failed [${status}]`, status)
  }
  return filterArkModels(parseArkModels(data), filter)
}

/**
 * Render model ids as the one-line hint an error message carries, e.g.
 * `doubao-seedance-2-0-mini-260615、doubao-seedance-2-0-260128`.
 * @param models - the available models.
 * @returns the ids joined with an ideographic comma, or `''` when there are none.
 */
export function formatModelIds(models: readonly MediaModelInfo[]): string {
  return models.map((model) => model.id).join('、')
}
