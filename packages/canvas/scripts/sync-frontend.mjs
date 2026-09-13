/**
 * Put the canvas workbench's built frontend inside this package.
 *
 * `@roubaai/canvas` ships the browser app it serves: the build lands in
 * `packages/canvas/frontend/`, travels inside the tarball, and is what a plain
 * install serves when no `canvasRoot` is configured. That is what keeps a
 * packaged install free of any path from the machine that built it.
 *
 * The frontend is built from the canvas checkout, which is a separate
 * repository, so this script either builds it there or copies a build that
 * already exists:
 *
 *   node packages/canvas/scripts/sync-frontend.mjs              # build, then copy
 *   node packages/canvas/scripts/sync-frontend.mjs --from <dir> # copy an existing build
 *   node packages/canvas/scripts/sync-frontend.mjs --check      # fail on drift, copy nothing
 *
 * The checkout is found at `$CANVAS_WEB_ROOT` when set, otherwise at the sibling
 * `../infinite-canvas/web` of this repository.
 *
 * @module roubaai-media/scripts/sync-frontend
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '..', '..')
const target = join(packageRoot, 'frontend')

/** The mount point the build must match; `index.html` references `/canvas/assets/...`. */
function basePath() {
  const raw = process.argv.find(argument => argument.startsWith('--base='))?.slice('--base='.length)
  const value = (raw ?? '/canvas').trim()
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.replace(/\/+$/u, '') || '/canvas'
}

/** The canvas frontend checkout this build comes from. */
function webRoot() {
  const configured = process.env.CANVAS_WEB_ROOT?.trim()
  if (configured !== undefined && configured !== '') return resolve(configured)
  return resolve(repositoryRoot, '..', 'infinite-canvas', 'web')
}

/**
 * Every file under a directory, relative and POSIX-separated.
 * @param root - the directory to walk.
 * @returns the relative paths, sorted.
 */
function listFiles(root) {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return found.sort()
}

/**
 * File count and total size, for the summary line.
 * @param root - the directory to measure.
 * @returns the counts.
 */
function measure(root) {
  const files = listFiles(root)
  const bytes = files.reduce((total, file) => total + statSync(join(root, file)).size, 0)
  return { files: files.length, bytes }
}

/**
 * Compare two built directories by content.
 * @param left - the first directory.
 * @param right - the second directory.
 * @returns the differing paths, capped for reporting.
 */
function differences(left, right) {
  if (!existsSync(left)) return ['(nothing built here yet)']
  if (!existsSync(right)) return ['(the source build is missing)']
  const leftFiles = listFiles(left)
  const rightFiles = listFiles(right)
  const changed = []
  const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  for (const file of new Set([...leftFiles, ...rightFiles])) {
    if (!leftFiles.includes(file) || !rightFiles.includes(file)) {
      changed.push(file)
      continue
    }
    if (digest(join(left, file)) !== digest(join(right, file))) changed.push(file)
  }
  return changed
}

/** Build the frontend in its checkout, with the base path this package serves. */
function build(checkout) {
  const base = `${basePath()}/`
  console.log(`sync-frontend: building ${checkout} with VITE_BASE=${base}`)
  // One command string with a shell: `bun` is `bun.cmd` on Windows, which only
  // the shell resolves, and the single-string form avoids the deprecation that
  // mixing a shell with an argument array triggers.
  const result = spawnSync('bun run build', {
    cwd: checkout,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, VITE_BASE: base },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`bun run build exited with ${String(result.status)}`)
}

/** Copy the checkout's build into this package. */
function copy(source) {
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  const { files, bytes } = measure(target)
  console.log(`sync-frontend: ${files} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${relative(repositoryRoot, target)}`)
}

function main() {
  const check = process.argv.includes('--check')
  const fromIndex = process.argv.indexOf('--from')
  const from = fromIndex === -1 ? undefined : process.argv[fromIndex + 1]

  if (check) {
    const source = from === undefined ? join(webRoot(), 'dist') : resolve(from)
    const drifted = differences(target, source)
    if (drifted.length > 0) {
      throw new Error(`the packaged frontend does not match the build in ${source}: ${drifted.slice(0, 5).join(', ')}${drifted.length > 5 ? ` (+${String(drifted.length - 5)} more)` : ''}`)
    }
    const { files } = measure(target)
    console.log(`sync-frontend: the packaged frontend matches ${source} (${String(files)} file(s))`)
    return
  }

  let source
  if (from !== undefined) {
    source = resolve(from)
    if (!existsSync(join(source, 'index.html'))) throw new Error(`${source} holds no index.html; point --from at a built web/dist`)
  } else {
    const checkout = webRoot()
    if (!existsSync(join(checkout, 'package.json'))) {
      throw new Error(`no canvas checkout at ${checkout}; set CANVAS_WEB_ROOT, or pass --from <built web/dist>`)
    }
    build(checkout)
    source = join(checkout, 'dist')
  }
  copy(source)
}

try {
  main()
} catch (error) {
  console.error(`sync-frontend: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
