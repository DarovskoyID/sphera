const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const ts = require('typescript');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const schema = { exports: {}, TextEncoder }; vm.createContext(schema);
vm.runInContext(compile('src/core/commercial/schema.ts'), schema);
const react = { useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
const queue = [];
const store = { exports: {}, AbortController, setTimeout, clearTimeout, fetch: (url, options) => new Promise(resolve => queue.push({ url, options, resolve })), require: name => name === './schema' ? schema.exports : react };
vm.createContext(store); vm.runInContext(compile('src/core/commercial/store.ts'), store);
const tick = () => new Promise(resolve => setImmediate(resolve));
const catalog = id => ({ instance_id: id, modules: [{ id: 'amocrm', name: { en: 'amoCRM' }, paid: true, scope: 'instance', delivery: 'declarative', migrated: true, available: true, subscription: { status: 'active', expires_at: null } }] });
const response = id => ({ ok: true, json: async () => catalog(id) });

(async () => {
  const a = store.exports.connectCommercial('https://node-a.test', 'token-a');
  assert.equal(queue[0].url, 'https://node-a.test/api/modules/commercial/');
  assert.equal(queue[0].options.headers.Authorization, 'Bearer token-a');
  a();
  const b = store.exports.connectCommercial('https://node-b.test', 'token-b');
  assert.equal(queue[0].options.signal.aborted, true);
  queue[0].resolve(response('old')); await tick();
  assert.equal(store.exports.useCommercial().status, 'loading');
  queue[1].resolve(response('new')); await tick();
  assert.equal(store.exports.useCommercial().server, 'https://node-b.test');
  assert.equal(store.exports.useCommercial().services[0].migrated, true);
  b(); assert.equal(store.exports.useCommercial().services.length, 0);

  let imported = false;
  let nativeLoaded = 0;
  const nativeIds = ['office', 'whiteboard', 'planner', 'conference', 'servers', 'channels', 'bots', 'diary', 'family', 'legal', 'multiserver', 'totp'];
  const native = {
    NATIVE_INFO: nativeIds.map(id => ({ id, installed: true, deployed: true, deps: [], bundle: 'core-native:' + id, delivery: 'core-native' })),
    NATIVE_LOADERS: Object.fromEntries(nativeIds.map(id => [id, async () => { nativeLoaded++; return { default: { id, sdkVersion: 2, setup: () => {} } }; }])),
  };
  const registry = { exports: {}, console, fetch: async () => ({ ok: true, json: async () => ({ modules: ['amocrm', 'bitrix', 'onec'].map(id => ({ id, installed: true, deployed: true, deps: [], bundle: 'api/modules/' + id + '/bundle.js' })) }) }), require: name => {
    if (name === 'react') return react;
    if (name.endsWith('/workspaces/native')) return native;
    if (name.endsWith('/WorkspaceContract')) return { wrapWorkspaceComponent: (_id, component) => component };
    if (name.endsWith('defineModule')) return { SDK_VERSION: 2 };
    if (name.endsWith('slots')) return { unregisterModuleSlots: () => {} };
    if (name.includes('api/modules/')) imported = true;
    return {};
  } };
  vm.createContext(registry); vm.runInContext(compile('src/core/modules/registry.ts'), registry);
  await registry.exports.connectModules('https://node.test', 'token');
  assert.equal(imported, false);
  assert.ok(registry.exports.useModules().modules.filter(module => ['amocrm', 'bitrix', 'onec'].includes(module.id)).every(module => !module.active));
  assert.equal(nativeLoaded, 12);
  assert.ok(registry.exports.useModules().modules.filter(module => nativeIds.includes(module.id)).every(module => module.active));
  console.log('PASS: catalog loads on login; stale node responses are ignored; logout clears subscriptions; CRM never imports legacy JS; 12 native editors load only from fixed core factories.');
})().catch(error => { console.error(error); process.exitCode = 1; });
