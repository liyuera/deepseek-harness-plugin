/**
 * Builds the browser bundle (`lib/client.js`) with the plugin's own
 * self-contained helper (`./build/client-bundle.ts`); the node half is
 * tsc-emitted directly into `lib/` (main: `lib/index.js`).
 *
 * Build from this directory: `npm run build` (or `tsc -p tsconfig.json &&
 * tsdown --config-loader tsx`). Nothing here reaches into the harness monorepo.
 */
import { clientBundleConfig } from './build/client-bundle.ts'

export default clientBundleConfig('@liyuera/dsh-chrome-browser', 'src/client/index.ts')
