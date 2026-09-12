/**
 * Landing media into the workspace asset tree (`<workspace>/.assets/<project>/…`).
 *
 * The single source of truth for where an asset goes and what its index row says.
 * The `media_asset_save` tool and the OpenAI facade both land through here, so a
 * file saved by an agent turn and one saved by a canvas run cannot disagree about
 * path rules, categories, or the index format.
 *
 * Path rules, inherited from the tool: `name` and `dir` are relative sub-paths
 * under `<workspace>/.assets/<project>/`; a `..` segment, a drive letter or a
 * leading slash is refused rather than sanitized, because a caller that tries to
 * escape the tree is not a caller whose intent we should guess.
 *
 * @module @roubaai/media/asset-landing
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { registerLocalMedia } from './media-cache.ts'

/** Asset categories the tools and the settings page agree on. */
export const ASSET_CATEGORIES = [
  'upload',
  'character',
  'scene',
  'prop',
  'keyframe',
  'video',
  'storyboard',
  'cover',
  'meta',
] as const

/** One asset category. */
export type AssetCategory = (typeof ASSET_CATEGORIES)[number]

/**
 * Whether a string names a supported asset category.
 * @param value - the candidate category.
 * @returns true when the value is one of {@link ASSET_CATEGORIES}.
 */
export function isAssetCategory(value: string): value is AssetCategory {
  return (ASSET_CATEGORIES as readonly string[]).includes(value)
}

/** One landing request: where the bytes go and how the index describes them. */
export interface LandRequest {
  /** Workspace root; the tree lives in `<workspace>/.assets`. */
  readonly workspace: string
  /** Project folder name under `.assets/`. */
  readonly project: string
  /** Sub-directory under the project, e.g. `01_角色/CH001_花十/02_定稿图`. */
  readonly dir: string
  /** Friendly file base name, without extension; may carry `/` sub-paths. */
  readonly name: string
  /** File extension without the dot (`png`, `jpg`, `mp4`). */
  readonly ext: string
  /** The bytes to write. */
  readonly bytes: Uint8Array
  /** Index category. */
  readonly category: string
  /** The reference the caller was given, recorded verbatim in the index. */
  readonly reference: string
  /** Public URL the bytes came from, when one exists. */
  readonly url?: string | undefined
  /** Same-origin URL to register these bytes under, when one exists. */
  readonly displayUrl?: string | undefined
}

/** Where one asset landed. */
export interface LandedAsset {
  /** Absolute path of the written file. */
  readonly path: string
  /** Path relative to `.assets/`, using `/` separators. */
  readonly relative: string
  /** Bytes written. */
  readonly bytes: number
}

function assertRelative(value: string, label: string, tool: string): string {
  if (value.trim() === '') throw new Error(`${tool}: ${label} is required`)
  if (/\.\./.test(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/')) {
    throw new Error(`${tool}: ${label} must be a relative sub-path without \`..\` or drive letters`)
  }
  // `/` stays a sub-path separator (character assets are filed as
  // 角色/类目/条目); every other character a filesystem refuses becomes `_`.
  return value.replace(/[\\:*?"<>|]/g, '_')
}

/**
 * Resolve the absolute file path one asset will be written to.
 * @param options - the landing request (bytes are not needed to resolve a path).
 * @param tool - the caller's name, used in error messages.
 * @returns the file path plus the sanitized name, directory and project root.
 */
export function resolveLandingPath(
  options: Pick<LandRequest, 'workspace' | 'project' | 'dir' | 'name' | 'ext'>,
  tool = 'asset_landing',
): { filePath: string; projectDir: string; safeName: string; safeDir: string } {
  const safeName = assertRelative(options.name, 'name', tool)
  const safeDir = assertRelative(options.dir, 'dir', tool)
  if (/\.\./.test(options.project) || /^[a-zA-Z]:[\\/]/.test(options.project) || options.project.startsWith('/')) {
    throw new Error(`${tool}: project must be a relative folder name without \`..\` or drive letters`)
  }
  const projectDir = join(options.workspace, '.assets', options.project)
  return { filePath: join(projectDir, safeDir, `${safeName}.${options.ext}`), projectDir, safeName, safeDir }
}

/** Append one line to the project asset index (writes the header on first use). */
export async function appendIndex(
  assetsDir: string,
  entry: { category: string; name: string; path: string; ref: string; url: string | undefined; ts: number; mediaType: string },
): Promise<void> {
  const indexPath = join(assetsDir, 'assets-index.md')
  const header = '| 类别 | 资产名 | 路径 | 原始URL | 时间 |\n|------|--------|------|--------|------|\n'
  let content = ''
  try {
    content = await readFile(indexPath, 'utf8')
  } catch {
    content = ''
  }
  if (!content.trim()) {
    await appendFile(indexPath, header)
  }
  const url = entry.url ?? ''
  const line = `| ${entry.category} | ${entry.name}.${entry.mediaType} | \`${entry.path}\` | ${url !== '' ? `\`${url}\`` : '-'} | ${new Date(entry.ts).toISOString()} |\n`
  await appendFile(indexPath, line)
}

/**
 * Write one media file into the asset tree and record it in the project index.
 * @param request - the bytes, their destination and their index description.
 * @returns where the file landed and how many bytes were written.
 */
export async function landMediaAsset(request: LandRequest): Promise<LandedAsset> {
  if (!isAssetCategory(request.category)) {
    throw new Error(`asset_landing: unsupported category ${request.category}; use one of ${ASSET_CATEGORIES.join(', ')}`)
  }
  const { filePath, projectDir, safeName, safeDir } = resolveLandingPath(request, 'asset_landing')
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, request.bytes)
  await appendIndex(projectDir, {
    category: request.category,
    name: safeName,
    path: filePath,
    ref: request.reference,
    url: request.url,
    ts: Date.now(),
    mediaType: request.ext,
  })
  // Register the landed file under its source URL, so the same-origin stream
  // route can serve THIS copy instead of going back to the provider.
  if (request.displayUrl !== undefined && request.displayUrl !== '') {
    registerLocalMedia({ url: request.displayUrl, filePath, mediaType: mediaMimeOf(request.ext) })
  }
  return { path: filePath, relative: `${request.project}/${safeDir}/${safeName}.${request.ext}`.replace(/\\/g, '/'), bytes: request.bytes.byteLength }
}

/** MIME for a saved file extension (media cache registration + asset index). */
export function mediaMimeOf(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'mp4': case 'm4v': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'mov': return 'video/quicktime'
    case 'mp3': return 'audio/mpeg'
    case 'm4a': return 'audio/mp4'
    case 'wav': return 'audio/wav'
    case 'aac': return 'audio/aac'
    case 'ogg': case 'oga': return 'audio/ogg'
    default: return 'application/octet-stream'
  }
}
