import { nodeBundle } from '../../build/tsdown.client.ts'

/** Node-only backend: the Volcengine Ark video generation provider. */
export default nodeBundle('@roubaai/media-ark', [
  'lib/types/index.js',
])
