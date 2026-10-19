const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const ts = require('typescript');
const context = { exports: {}, TextEncoder };
vm.createContext(context);
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
vm.runInContext(compile(fs.readFileSync('src/core/commercial/schema.ts', 'utf8')), context);
const { parseServiceDocument } = context.exports;
const { parseServiceCatalog } = context.exports;
const service = { id: 'office', name: { ru: 'Документы', en: 'Documents' }, paid: true, scope: 'instance', delivery: 'declarative', available: true, subscription: { status: 'active', expires_at: '2030-01-01T00:00:00Z' } };
const catalog = modules => ({ instance_id: 'server-id', modules });
assert.equal(parseServiceCatalog(catalog([service]))[0], service);
assert.equal(parseServiceCatalog(catalog([{ ...service, installed: false }]))[0].installed, false);
for (const bad of [
  { ...service, installed: 'yes' }, { ...service, installed: true, available: false },
  { ...service, paid: false }, { ...service, scope: 'user' },
  { ...service, url: 'https://evil.test' },
  { ...service, subscription: { status: 'expired', expires_at: null } },
  { ...service, subscription: { status: 'active', expires_at: 'invalid' } },
]) assert.throws(() => parseServiceCatalog(catalog([bad])));
assert.throws(() => parseServiceCatalog(catalog([service, service])));
const valid = { schema: 'sfera-ui/v1', title: 'Paid service', nodes: [{ kind: 'text', text: '<script>alert(1)</script>' }, { kind: 'table', columns: ['Name'], rows: [['<img src=x onerror=alert(1)>']] }, { kind: 'form', id: 'lead', action: 'create-lead', label: 'Save', fields: [{ id: 'name', kind: 'text', label: 'Name', required: true }] }] };
assert.equal(parseServiceDocument(valid), valid);
const reject = nodes => assert.throws(() => parseServiceDocument({ schema: 'sfera-ui/v1', title: 'x', nodes }));
reject([{ kind: 'script', source: 'alert(1)' }]);
assert.equal(parseServiceDocument({ schema: 'sfera-ui/v1', title: 'Planner', nodes: [{ kind: 'workspace', id: 'planner' }] }).nodes[0].id, 'planner');
reject([{ kind: 'workspace', id: 'https://evil.test/plugin.js' }]);
reject([{ kind: 'workspace', id: 'planner', source: 'eval()' }]);
reject([{ kind: 'text', text: 'x', html: '<script />' }]);
reject([{ kind: 'form', id: 'f', action: 'https://evil.test', label: 'x', fields: [] }]);
reject([{ kind: 'form', id: 'f', action: 'ok', label: 'x', fields: [{ id: '__proto__', kind: 'text', label: 'x' }] }]);
reject([{ kind: 'table', columns: ['a'], rows: [[{}, 'extra']] }]);
reject([{ kind: 'table', columns: ['a'], rows: [[NaN]] }]);
reject(Array.from({ length: 101 }, () => ({ kind: 'text', text: 'x' })));
let deep = { kind: 'text', text: 'x' };
for (let i = 0; i < 8; i++) deep = { kind: 'section', title: 'x', nodes: [deep] };
reject([deep]);
reject([{ kind: 'text', text: 'x'.repeat(4001) }]);
const renderer = { exports: {}, require: name => name === './schema' ? context.exports : require(name) };
vm.createContext(renderer);
vm.runInContext(compile(fs.readFileSync('src/core/commercial/ServiceDocument.tsx', 'utf8')), renderer);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const messages = { invalid: 'Invalid response', pending: 'Working', failed: 'Action failed' };
const html = renderToStaticMarkup(React.createElement(renderer.exports.CommercialDocument, { document: valid, messages, onAction: async () => {} }));
assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
const invalid = renderToStaticMarkup(React.createElement(renderer.exports.CommercialDocument, { document: { ...valid, script: 'x' }, messages, onAction: async () => {} }));
assert.ok(invalid.includes('Invalid response'));
console.log('PASS: declarative contract accepts known UI; rejects executable/HTML/URL nodes, prototype keys, oversized/nested payloads and invalid tables; renderer escapes remote strings.');

const expiryContext = { exports: {} }; vm.createContext(expiryContext);
vm.runInContext(compile(fs.readFileSync('src/core/commercial/subscription.ts', 'utf8')), expiryContext);
const oldTimezone = process.env.TZ;
try {
  process.env.TZ = 'Europe/Moscow';
  const end = expiryContext.exports.formatSubscriptionExpiry('2027-10-18T21:00:00Z', 'ru');
  assert.ok(end.includes('19.10.2027') && end.includes('00:00'), end);
  assert.ok(/GMT\+3|МСК|MSK/.test(end), end);
  assert.equal(expiryContext.exports.formatSubscriptionExpiry(null, 'ru'), null);
  assert.equal(expiryContext.exports.formatSubscriptionExpiry('not-a-date', 'ru'), null);
} finally { if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone; }
console.log('PASS: subscription expiration includes local date, time and timezone; UTC date rollover is correct.');
