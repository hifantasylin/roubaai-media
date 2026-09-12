import { defineConfig } from 'vitest/config'

/**
 * Package tests run against `src/` through Vitest's own transform, so a spec
 * exercises the module the build consumes rather than a stale `lib/` artifact.
 * The repository has no shared test runtime: each spec boots the Cordis
 * services it needs and stubs external I/O.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts'],
    // Package specs boot real Cordis contexts and touch the filesystem; running
    // them in one worker keeps temporary directories and ports from colliding.
    pool: 'forks',
  },
})
