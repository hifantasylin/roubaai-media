/**
 * A temp asset root for one spec file.
 *
 * The asset root is resolved from the environment (`asset-root.ts`), so a spec
 * that exercises landing or the library must claim it: without this, a test run
 * would write into the developer's real `$DSH_HOME/assets`.
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Install/restore pair around one spec file's temp root. */
export interface TempAssetsRoot {
  /** Create the directory and point the resolver at it; returns its path. */
  install(): string
  /** Forget the override and delete the directory. */
  restore(): Promise<void>
}

/**
 * Build the pair.
 * @param prefix - temp-directory name prefix, so a leftover is identifiable.
 * @returns the install/restore pair.
 */
export function createTempAssetsRoot(prefix: string): TempAssetsRoot {
  const previous = process.env['DSH_MEDIA_ASSETS_ROOT']
  let created = ''
  return {
    install() {
      created = mkdtempSync(join(tmpdir(), prefix))
      process.env['DSH_MEDIA_ASSETS_ROOT'] = created
      return created
    },
    async restore() {
      if (previous === undefined) delete process.env['DSH_MEDIA_ASSETS_ROOT']
      else process.env['DSH_MEDIA_ASSETS_ROOT'] = previous
      const directory = created
      created = ''
      // A served file's stream may still be closing; Windows refuses the
      // directory until it has, so the delete retries rather than failing a spec.
      if (directory !== '') await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    },
  }
}
