#!/usr/bin/env node
/**
 * Build one module frontend into a standalone ES module loaded at runtime.
 *
 *   node scripts/modules/build-module.mjs <module dir> <out file>
 *
 * React and `@sfera/sdk` are not bundled: imports of them resolve to the copies
 * the running core exposes on `window.__SFERA_SHARED__` (src/core/modules/shared.ts).
 * Everything else (lucide-react, the module's own npm dependencies) is bundled.
 * A module with its own package.json gets `npm install` first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [moduleDir, outFile] = process.argv.slice(2).map(p => p && resolve(p));
if (!moduleDir || !outFile) {
  console.error('usage: build-module.mjs <module dir> <out file>');
  process.exit(2);
}

const entry = ['index.tsx', 'index.ts'].map(f => join(moduleDir, 'frontend', f)).find(existsSync);
if (!entry) {
  console.error(`no frontend/index.tsx in ${moduleDir}`);
  process.exit(1);
}

// Install (again) when the module's dependency list is newer than what is installed.
const pkg = join(moduleDir, 'package.json');
const installed = join(moduleDir, 'node_modules', '.package-lock.json');
if (existsSync(pkg) && (!existsSync(installed) || statSync(pkg).mtimeMs > statSync(installed).mtimeMs)) {
  const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  // npm is a .cmd script on Windows and needs a shell to run.
  if (process.platform === 'win32') execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...npmArgs], { cwd: moduleDir, stdio: 'inherit' });
  else execFileSync('npm', npmArgs, { cwd: moduleDir, stdio: 'inherit' });
}

const SHARED = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@sfera/sdk'];

const shared = {
  name: 'sfera-shared',
  setup(b) {
    const filter = new RegExp(`^(${SHARED.map(s => s.replace(/[/.]/g, '\\$&')).join('|')})$`);
    b.onResolve({ filter }, args => ({ path: args.path, namespace: 'sfera-shared' }));
    // CommonJS-style proxy: esbuild maps named imports onto it.
    b.onLoad({ filter: /.*/, namespace: 'sfera-shared' }, args => ({
      contents: `const s = window.__SFERA_SHARED__ && window.__SFERA_SHARED__[${JSON.stringify(args.path)}];
if (!s) throw new Error('Sfera core does not expose ${args.path}');
module.exports = s;`,
      loader: 'js',
    }));
  },
};

mkdirSync(dirname(outFile), { recursive: true });
const tmp = `${outFile}.${process.pid}.tmp`;
await build({
  entryPoints: [entry],
  outfile: tmp,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [shared],
  // lucide-react etc. come from the core's node_modules when the module has none.
  nodePaths: [join(moduleDir, 'node_modules'), join(ROOT, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
});
renameSync(tmp, outFile);
console.log(`built ${outFile}`);
