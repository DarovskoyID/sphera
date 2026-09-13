#!/usr/bin/env node
/**
 * Check out Sfera modules from their branches into ./modules/<id>.
 *
 *   node scripts/modules/fetch.mjs            # pinned commits from modules.lock.json (deploy / CI)
 *   node scripts/modules/fetch.mjs --dev      # branch heads, attached, for working on modules
 *   node scripts/modules/fetch.mjs --only servers,channels
 *   node scripts/modules/fetch.mjs --update   # re-pin modules.lock.json to the current branch heads
 *
 * Each module lives on its own branch (module/<id>) whose root is the module:
 * module.json, backend/<django app>, frontend/index.tsx. Modules are git
 * worktrees of this repository, so no extra clone or credentials are needed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCK = join(ROOT, 'modules.lock.json');
const MODULES_DIR = join(ROOT, 'modules');

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const update = args.includes('--update');
const onlyArg = args.find(a => a.startsWith('--only'));
const only = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1]).split(',') : null;
const remote = process.env.SFERA_MODULES_REMOTE || 'origin';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };

const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
const entries = Object.entries(lock.modules).filter(([id]) => !only || only.includes(id));

mkdirSync(MODULES_DIR, { recursive: true });

for (const [id, spec] of entries) {
  const branch = spec.branch || `module/${id}`;
  const target = join(MODULES_DIR, id);

  // Make the branch available locally (remote may be absent in a fresh clone).
  const fetched = tryGit('fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
  const remoteRef = `${remote}/${branch}`;
  const haveRemote = fetched !== null && tryGit('rev-parse', '--verify', '--quiet', remoteRef);
  const haveLocal = tryGit('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  const head = haveRemote ? git('rev-parse', remoteRef) : haveLocal ? git('rev-parse', branch) : null;
  if (!head) {
    console.error(`✗ ${id}: branch ${branch} not found (neither ${remoteRef} nor local)`);
    process.exitCode = 1;
    continue;
  }

  if (update) {
    lock.modules[id] = { ...spec, branch, ref: head };
    console.log(`↻ ${id}: pinned ${head.slice(0, 12)}`);
    continue;
  }

  const ref = dev ? branch : (spec.ref || head);
  if (dev && !haveLocal && haveRemote) git('branch', '--track', branch, remoteRef);

  if (existsSync(join(target, '.git'))) {
    // Existing worktree: move it to the wanted commit / branch.
    execFileSync('git', dev ? ['checkout', '--quiet', branch] : ['checkout', '--quiet', '--detach', ref],
      { cwd: target, stdio: 'inherit' });
  } else {
    tryGit('worktree', 'prune');
    git('worktree', 'add', '--force', ...(dev ? [target, branch] : ['--detach', target, ref]));
  }
  console.log(`✓ ${id}: ${dev ? branch : ref.slice(0, 12)}`);
}

if (update) {
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
}
