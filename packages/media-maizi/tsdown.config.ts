import { nodeBundle } from '../../build/tsdown.client.ts'

/** Node-only backend: the MaiziAI image and video generation provider. */
export default nodeBundle('@roubaai/media-maizi', [
  'lib/types/index.js',
])
