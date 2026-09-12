/**
 * Extend `JobKindMap` via declaration merging so `ctx.jobs.start({ kind:
 * 'media-video', ... })` type-checks. The registry treats each value as an
 * opaque id namespace; this file is imported by the media package entry so the
 * merge takes effect wherever the media package is assembled.
 *
 * @module @roubaai/media/job-kind
 */

import type {} from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'media-video': 'media-video'
    'media-image': 'media-image'
    'media-music': 'media-music'
    'media-asset': 'media-asset'
    'media-extract-frame': 'media-extract-frame'
  }
}
