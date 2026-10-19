const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const ts = require('typescript');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function load(file, dependencies, globals = {}) {
  const context = { exports: {}, AbortController, setTimeout, clearTimeout, ...globals, require: name => name in dependencies ? dependencies[name] : require(name) };
  vm.createContext(context); vm.runInContext(compile(file), context); return context.exports;
}
const metadata = load('src/core/commercial/catalog.ts', {});
const ids = metadata.MODULE_CATALOG.map(m => m.id);
assert.equal(new Set(ids).size, 15);
let values = [], cursor = 0, callbacks = [];
const hooks = { useState: init => { const i = cursor++; if (!(i in values)) values[i] = init; return [values[i], value => { values[i] = value; }]; }, useEffect: () => {}, useRef: init => { const i = cursor++; if (!(i in values)) values[i] = { current: init }; return values[i]; } };
const render = component => { cursor = 0; return component(); };
const reset = () => { values = []; cursor = 0; };
const app = { language: 'ru', currentUser: { id: 1, is_superuser: true }, currentServerIP: 'https://node.test', authToken: 'session', setCurrentServer: () => {}, setCurrentSettingsPage: () => {} };
let state = { services: [], status: 'ready', server: app.currentServerIP };
const store = { useCommercial: () => state, refreshCommercial: async () => { callbacks.push('refreshed'); } };
const dependencies = { react: hooks, '../../context/AppContext': { useApp: () => app }, './store': store, './catalog': metadata, './navigation': { openWorkspace: id => callbacks.push(id) }, './ActivationForm': { ActivationForm: () => null } };
const cards = load('src/core/commercial/Cards.tsx', dependencies);
function all(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  const children = node.props?.children;
  return [...(predicate(node) ? [node] : []), ...[children].flat(Infinity).flatMap(child => all(child, predicate))];
}
for (const id of ids) {
  reset();
  let tree = render(cards.CommercialCards);
  const article = all(tree, n => n.type === 'article' && n.props['data-module-id'] === id)[0];
  assert.ok(article, id);
  const install = all(article, n => n.type === 'button')[0];
  assert.equal(install.props.disabled, false);
  install.props.onClick();
  tree = render(cards.CommercialCards);
  const dialog = all(tree, n => n.props?.module?.id === id)[0];
  assert.ok(dialog, `Install opens a key dialog for ${id}`);
  assert.deepEqual(callbacks, []); // Never navigates or downloads old module code.
}
state.services = ids.map(id => ({ id, available: true, subscription: { status: 'active' } }));
reset();
for (const article of all(render(cards.CommercialCards), n => n.type === 'article')) {
  all(article, n => n.type === 'button')[0].props.onClick();
}
assert.equal(JSON.stringify(callbacks), JSON.stringify(ids));
app.currentUser.is_superuser = false; state.services = [];
reset(); assert.ok(all(render(cards.CommercialCards), n => n.type === 'article').every(n => all(n, b => b.type === 'button')[0].props.disabled));
app.currentUser.is_superuser = true; callbacks = [];
let requests = [], failure = false, release;
const activation = load('src/core/commercial/ActivationForm.tsx', { ...dependencies }, { fetch: async (url, options) => { requests.push({ url, options }); if (release) await release; return { ok: !failure, json: async () => failure ? { error: 'license_module_mismatch' } : { activated: true, modules: ids } }; } });
(async () => {
  for (const id of ids) {
    reset(); let closed = false;
    const props = { moduleId: id, onActivated: () => { closed = true; } };
    let form = render(() => activation.ActivationForm(props));
    all(form, n => n.type === 'input')[0].props.onChange({ target: { value: 'SFERA-example-test-key' } });
    form = render(() => activation.ActivationForm(props));
    await form.props.onSubmit({ preventDefault() {} });
    const request = requests.at(-1);
    assert.equal(JSON.parse(request.options.body).module_id, id);
    assert.equal(request.url, app.currentServerIP + '/api/modules/commercial/activate/');
    assert.ok(closed);
    assert.equal(all(render(() => activation.ActivationForm(props)), n => n.type === 'input')[0].props.value, '');
  }
  reset(); failure = true; let closed = false;
  const props = { moduleId: 'office', onActivated: () => { closed = true; } };
  all(render(() => activation.ActivationForm(props)), n => n.type === 'input')[0].props.onChange({ target: { value: 'wrong-key' } });
  await render(() => activation.ActivationForm(props)).props.onSubmit({ preventDefault() {} });
  assert.equal(closed, false);
  assert.equal(all(render(() => activation.ActivationForm(props)), n => n.type === 'input')[0].props.value, 'wrong-key');
  assert.ok(all(render(() => activation.ActivationForm(props)), n => n.props?.role === 'status').length);
  console.log('PASS: all 15 cards open a selected-module key dialog; activation refreshes access and clears the key; mismatch keeps the dialog open; active cards open modules; non-admin installs are disabled.');
})().catch(error => { console.error(error); process.exitCode = 1; });
