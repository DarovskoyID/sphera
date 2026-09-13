#!/usr/bin/env node
/**
 * Assemble Grafana dashboards and Prometheus alert rules from the core and the
 * checked-out modules into django-server/monitoring/generated/, which the
 * prometheus and grafana containers mount.
 *
 *   node scripts/modules/monitoring.mjs
 *   SFERA_MONITORING_EXCLUDE=diary,family node scripts/modules/monitoring.mjs
 *   node scripts/modules/monitoring.mjs --exclude core,bots
 *
 * Sources:
 *   core    django-server/monitoring/grafana/dashboards/*.json, monitoring/alert_rules.yml
 *   module  modules/<id>/monitoring/grafana/*.json,           modules/<id>/monitoring/alert_rules.yml
 *
 * A module's monitoring is left out when its id is in the exclude list or its
 * entry in modules.lock.json has "monitoring": false. "core" excludes the core
 * dashboards and alerts. Output is rebuilt from scratch on every run.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MON = join(ROOT, 'django-server', 'monitoring');
const OUT = join(MON, 'generated');

const args = process.argv.slice(2);
const exArg = args.indexOf('--exclude');
const exclude = new Set(
  [process.env.SFERA_MONITORING_EXCLUDE, exArg >= 0 ? args[exArg + 1] : '']
    .filter(Boolean).join(',').split(',').map(s => s.trim()).filter(Boolean),
);

const lockPath = join(ROOT, 'modules.lock.json');
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).modules : {};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'dashboards'), { recursive: true });
mkdirSync(join(OUT, 'rules'), { recursive: true });

function add(source, { dashboards, rules }) {
  let n = 0;
  if (existsSync(dashboards)) {
    const files = readdirSync(dashboards).filter(f => f.endsWith('.json'));
    if (files.length) mkdirSync(join(OUT, 'dashboards', source), { recursive: true });
    for (const f of files) {
      // Validate: a broken JSON would silently hide the whole folder in Grafana.
      JSON.parse(readFileSync(join(dashboards, f), 'utf8'));
      copyFileSync(join(dashboards, f), join(OUT, 'dashboards', source, f));
      n++;
    }
  }
  if (existsSync(rules)) {
    copyFileSync(rules, join(OUT, 'rules', `${source}.yml`));
    n++;
  }
  return n;
}

const included = [];
if (!exclude.has('core')) {
  add('core', { dashboards: join(MON, 'grafana', 'dashboards'), rules: join(MON, 'alert_rules.yml') });
  included.push('core');
}

const modulesDir = join(ROOT, 'modules');
const ids = existsSync(modulesDir)
  ? readdirSync(modulesDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(modulesDir, e.name, 'module.json')))
      .map(e => e.name)
  : [];
for (const id of ids.sort()) {
  if (exclude.has(id) || lock[id]?.monitoring === false) {
    console.log(`– ${id}: monitoring skipped`);
    continue;
  }
  const mon = join(modulesDir, id, 'monitoring');
  const n = add(id, { dashboards: join(mon, 'grafana'), rules: join(mon, 'alert_rules.yml') });
  if (n) included.push(id);
}
console.log(`✓ monitoring: ${included.join(', ') || 'nothing'} → ${OUT}`);
