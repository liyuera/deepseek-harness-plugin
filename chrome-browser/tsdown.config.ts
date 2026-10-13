/**
 * Builds the browser bundle (lib/client.js) with the shared out-of-tree
 * helper (../build/client-bundle.ts); the node half is tsc-emitted directly
 * into lib/ (main: lib/index.js). The harness workspace preset only serves
 * packages under packages (group/package glob), so this repo holds its own dynamic client
 * channel. Build from this directory: `tsc -b && tsdown --config-loader tsx`
 * (bins resolve from the harness root node_modules).
 */
import { clientBundleConfig } from '../build/client-bundle.ts'

export default clientBundleConfig('@liyuera/dsh-chrome-browser', 'lib/client/index.js')
