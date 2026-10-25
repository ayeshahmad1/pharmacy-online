// Production build: bundles src/server.ts and the workspace packages it uses
// (@pharmacy/shared ships TypeScript source) into dist/server.js. Everything
// from node_modules stays external and is loaded from the installed packages.
//
// Run with: pnpm --filter api build

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.entries(pkg.dependencies)
  .filter(([, version]) => !version.startsWith('workspace:'))
  .map(([name]) => name);

await build({
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external,
  sourcemap: true,
  logLevel: 'info',
});
