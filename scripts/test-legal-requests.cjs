const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('src/core/workspaces/legal/LegalView.tsx', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText + '\nexports.ProtocolDetail = ProtocolDetail;';
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
let hooks = [], cursor = 0, effects = [], requests = [], back = 0;
const react = {
  useState: initial => { const i = cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, value => { hooks[i].value = value; }]; },
  useRef: initial => { const i = cursor++; return hooks[i] ??= { current: initial }; },
  useMemo: (create, deps) => { const i = cursor++; if (!same(hooks[i]?.deps, deps)) hooks[i] = { value: create(), deps }; return hooks[i].value; },
  useCallback: (fn, deps) => react.useMemo(() => fn, deps),
  useEffect: (effect, deps) => { const i = cursor++; if (!same(hooks[i]?.deps, deps)) { hooks[i]?.cleanup?.(); hooks[i] = { deps }; effects.push(() => { hooks[i].cleanup = effect(); }); } },
};
const core = { language: 'ru', currentServerIP: 'https://node.test', authToken: 'token', currentUser: { id: 'me' } };
const api = { get: (conn, id, signal) => new Promise((resolve, reject) => requests.push({ conn, id, signal, resolve, reject })) };
const context = { exports: {}, AbortController, require: name => {
  if (name === 'react') return react;
  if (name === '@sfera/sdk') return { useCore: () => core, useModuleT: () => key => key };
  if (name === './api') return { api };
  if (name === './store' || name === './Verify' || name === './kit' || name === './ui') return new Proxy({}, { get: () => () => null });
  return require(name);
} };
vm.createContext(context); vm.runInContext(code, context);
function render(id = 'package-a') {
  cursor = 0;
  context.exports.ProtocolDetail({ id, onBack: () => { back++; } });
  const pending = effects; effects = []; pending.forEach(effect => effect());
}
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  for (let i = 0; i < 200; i++) render();
  assert.equal(requests.length, 1, 'A fresh parent onBack callback must not refetch the package');
  render('package-b');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].reject(new Error('old response')); await tick();
  assert.equal(back, 0, 'Aborted requests must not navigate away');
  requests[1].resolve({ id: 'package-b', status: 'draft', signatures: [], participants: [], requests: [], is_owner: false }); await tick();
  for (let i = 0; i < 100; i++) render('package-b');
  assert.equal(requests.length, 2);
  core.authToken = 'new-session'; render('package-b');
  assert.equal(requests.length, 3, 'New credentials must refetch');
  requests[2].reject(new Error('denied')); await tick();
  assert.equal(back, 1, 'A genuine failure uses the latest back handler');
  hooks.forEach(hook => hook?.cleanup?.());
  assert.equal(requests[2].signal.aborted, true);
  console.log('PASS: 300 unrelated rerenders produce one request per legal package; package/session changes refetch; obsolete requests abort without stale navigation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
