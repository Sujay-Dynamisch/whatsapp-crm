// Bundles src/index.ts — and the app code it imports from ../../src
// via the `@/` alias — into a single dist/index.js. The deployed
// function therefore runs the exact same broadcast delivery code as
// the Next.js app, with no runtime npm install of app dependencies.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'inline',
  // Root tsconfig carries the `@/*` → `src/*` path mapping.
  tsconfig: resolve(here, '../../tsconfig.json'),
  // Resolve @supabase/supabase-js etc. from the app's node_modules.
  nodePaths: [resolve(here, '../../node_modules')],
  logLevel: 'info',
});
