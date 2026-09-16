/**
 * Standalone tsdown preset for the RoubaAI media plugin family.
 *
 * Mirrors the DeepSeek Harness `clientBundle` artifact protocol
 * (`packages/client/tsdown.client.ts`) without importing anything from the
 * harness repository — this repo builds on its own, against the published
 * `@deepseek-ai/*` packages.
 *
 * Two artifacts per client-bearing package:
 *
 * - Node half: one ESM bundle per entry, emitted from the tsc output under
 *   `lib/types`. Every `@deepseek-ai/*` and `@roubaai/*` specifier stays an
 *   import: the harness install supplies those at runtime.
 * - Client half: a CJS closure-factory artifact calling
 *   `window.__ModuleLoader__.load({ id, factory })`, whose `require` resolves
 *   the loader's module table (React, Cordis, and the static client libraries
 *   the shell seeds). CSS Modules compile through lightningcss into a hashed
 *   class map, and the sheet auto-injects a `<style data-plugin-css>` tag when
 *   the factory runs.
 *
 * The purity gate rejects any other `@deepseek-ai/*` value import: inlining a
 * second runtime instance of a service the host already owns cannot work, and
 * the module table cannot answer a specifier this package never declared.
 * Type-only imports are erased by tsc and never reach the gate, so shared
 * declarations cross packages freely.
 *
 * @module roubaai-media/build/tsdown.client
 */

import { existsSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, relative as relativePath, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/**
 * Platform seed entries the browser module table answers (external). This is
 * the harness client baseline: shell-seeded React, Cordis, and the static
 * client libraries. Subpaths are listed explicitly because module-table
 * matching is exact, never normalized.
 */
const PLATFORM_MODULES: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Wire/type layers a client bundle may inline (no shared runtime identity). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(session|llm|tools|brand)(\/|$)/

/** Vendored framework libraries: ordinary libraries, no cross-plugin identity. */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline.
 * The suffix matters: tsdown's guard matches ids ending in `.css`, so the
 * virtual id must not.
 *
 * The id names the stylesheet *relative to the package root*, because rolldown
 * echoes a module id into the emitted `//#region` comment: an absolute one
 * stamps the builder's own checkout path into the shipped bundle, which is
 * both noise and a small leak of whoever ran the pack.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The package root tsdown is run in; virtual ids are spelled relative to it. */
const PACKAGE_ROOT = process.cwd()

/**
 * The virtual id for one stylesheet. Falls back to the absolute path for a
 * stylesheet outside the package root, where a relative id would only be a
 * longer way of writing the same thing.
 * @param absolute - the stylesheet's absolute path.
 * @returns the virtual module id.
 */
function cssVirtualId(absolute: string): string {
  const relative = relativePath(PACKAGE_ROOT, absolute)
  const portable = relative.startsWith('..') ? absolute : relative.split(sep).join('/')
  return CSS_VIRTUAL_PREFIX + portable + CSS_VIRTUAL_SUFFIX
}

/**
 * The stylesheet a virtual id names.
 * @param virtualId - a value produced by {@link cssVirtualId}.
 * @returns the absolute path to read and to watch.
 */
function cssFileOf(virtualId: string): string {
  const id = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
  return isAbsolute(id) ? id : resolvePath(PACKAGE_ROOT, id)
}

/** Path segment separating a package's tsc output from the sources it came from. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/**
 * Node-half externals. Everything the harness install provides stays an import;
 * anything else (and every relative module) is bundled. Stating both sides of
 * the rule takes the artifact off tsdown's production-dependency inference, so
 * moving a name between npm sections cannot silently change bundle contents.
 */
const NODE_EXTERNALS: readonly RegExp[] = [/^@deepseek-ai\//, /^@roubaai\//, /^node:/]

/** Whether the node half must leave a specifier as an import. */
function isNodeExternal(specifier: string): boolean {
  return NODE_EXTERNALS.some(pattern => pattern.test(specifier))
}

/** Where each package's tsc output lands, and therefore where tsdown reads from. */
const TYPES_OUT_DIR = 'lib/types'

/** Where tsdown writes the runtime artifacts. */
const LIB_OUT_DIR = 'lib'

/** The browser half's compiled entry, relative to the package root. */
const CLIENT_ENTRY = `${TYPES_OUT_DIR}/client/index.js`

/** The node-half bundle: ESM, one output file per named entry. */
function nodeConfig(id: string, libEntries: readonly string[], outDir: string): UserConfig {
  return {
    name: id,
    entry: [...libEntries],
    outDir,
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: [...NODE_EXTERNALS],
      // Builtins keep tsdown's own handling (neither side claims them).
      alwaysBundle: (specifier: string) => !isNodeExternal(specifier) && !isBuiltin(specifier),
    },
  }
}

/**
 * The browser-half bundle: a CJS closure factory the harness module loader
 * evaluates. `id` is both the module-table key and the style-tag owner, so it
 * must be the package name.
 */
function clientConfig(id: string, entry: string, outDir: string): UserConfig {
  const isExternal = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir,
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // The module table is the package's whole request list: a specifier it
      // answers stays an import, everything else inlines. A require() the table
      // cannot answer is a guaranteed runtime throw.
      neverBundle: [...PLATFORM_MODULES],
      alwaysBundle: (specifier: string) => !isExternal(specifier),
    },
    // Browser bundles inline node-idiom dependencies (zustand/immer read
    // process.env.NODE_ENV; zustand's esm build also probes import.meta.env).
    // A CJS output cannot carry import.meta, so both keys are substituted, and
    // the bare `import.meta.env` key is required alongside the precise MODE
    // key: a truthiness probe would otherwise survive as an empty import.meta.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'roubaai-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isExternal(source)) return null // requested module-table row: external wins
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution
        throw new Error(
          `client bundle purity: "${source}" is not a platform module, an inline-safe wire layer, `
          + `or a generated /remote contribution — cross-plugin value imports are forbidden; `
          + `collaborate through cordis services (type-only imports are erased and never reach this gate)`,
        )
      },
    }, {
      name: 'roubaai-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const absolute = importer !== undefined ? sourceAssetPath(source, importer) : source
        return cssVirtualId(absolute)
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = cssFileOf(virtualId)
        // The virtual id otherwise hides the physical stylesheet from the watch graph.
        this.addWatchFile(fileId)
        const source = readFileSync(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        // Sorted so the emitted class map is byte-stable: lightningcss promises
        // no export order, and an unstable one would rewrite lib/client.js on
        // every build for no reason.
        const classMap: Record<string, string> = {}
        const sorted = Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        for (const [local, exported] of sorted) classMap[local] = exported.name
        const tagId = `${id}/${basename(fileId)}`
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/**
 * Build both halves of one client-bearing plugin package: the node library
 * bundles plus the browser closure-factory bundle.
 * @param id - package name; stamped into the `__ModuleLoader__.load` handoff and onto style tags.
 * @param libEntries - node-half entries, spelled at the call site as paths under the tsc output.
 * @returns the tsdown configs for this package.
 */
export function clientBundle(id: string, libEntries: readonly string[]): UserConfig[] {
  return [nodeConfig(id, libEntries, LIB_OUT_DIR), clientConfig(id, CLIENT_ENTRY, LIB_OUT_DIR)]
}

/**
 * Build one node-only plugin package (a provider backend with no browser half).
 * @param id - package name, used in tsdown diagnostics.
 * @param libEntries - node-half entries under the tsc output.
 * @returns the tsdown configs for this package.
 */
export function nodeBundle(id: string, libEntries: readonly string[]): UserConfig[] {
  return [nodeConfig(id, libEntries, LIB_OUT_DIR)]
}

/**
 * Resolve an emitted asset import against its source-tree counterpart: tsc
 * mirrors `src/` under `lib/types/`, so a CSS import written against the
 * emitted file must be rebased onto the real stylesheet.
 */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}
