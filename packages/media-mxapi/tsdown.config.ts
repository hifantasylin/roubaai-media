import { nodeBundle } from '../../build/tsdown.client.ts'

/** Node-only backend: the MxAPI music generation provider. */
export default nodeBundle('@roubaai/media-mxapi', [
  'lib/types/index.js',
])
