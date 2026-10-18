const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('src/context/AppContext.tsx', 'utf8').replace(/\r\n/g, '\n');
const transpile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const notices = [];
let busy = false;
const context = {
  useCallback: callback => callback,
  setErrorMessage: () => {},
  _dispatch: message => notices.push(message),
  state: { language: 'ru' },
  t: (_language, key) => key,
  isBusy: () => busy,
  setBusy: (_owner, value) => { busy = value; },
  activeCallPeerRef: { current: null },
  callTargetIdRef: { current: null },
  runLifecycle: () => {},
  setState: update => { context.state = update(context.state); },
};
vm.createContext(context);
vm.runInContext(transpile(section('  const showError = useCallback', '  const clearError = useCallback') + '\nglobalThis.showError = showError;'), context);
vm.runInContext(transpile(section('  const startCall = (peerId:', '  const setCallActive = (active:') + '\nglobalThis.startCall = startCall;'), context);
context.startCall('alice', true);
assert.equal(context.state.isCallActive, true);
assert.equal(context.state.isVideoActive, true);
assert.equal(context.activeCallPeerRef.current, 'alice');
const activeState = context.state;
context.startCall('bob', false);
assert.equal(context.state, activeState, 'blocked attempt must preserve active video and target');
assert.equal(context.callTargetIdRef.current, 'alice');
assert.equal(notices.pop(), 'call_local_busy', 'blocked attempts must display a visible notification');
// The central WebSocket route must reply even without a mounted call handler.
const offerStart = source.indexOf("        if (data.type === 'offer' && data.from) {");
const busyRoute = source.slice(offerStart + "        if (data.type === 'offer' && data.from) {".length, source.indexOf('          setState', offerStart));
const replies = [];
context.ws = { send: data => replies.push(JSON.parse(data)) };
vm.runInContext(transpile(`globalThis.routeOffer = data => { ${busyRoute} return 'forward'; };`), context);
assert.equal(context.routeOffer({ type: 'offer', from: 'bob' }), undefined);
assert.equal(replies[0].callStatus, 'busy');
assert.equal(context.routeOffer({ type: 'offer', from: 'alice' }), 'forward', 'active-peer renegotiation must proceed');
context.activeCallPeerRef.current = null;
context.routeOffer({ type: 'offer', from: 'bob' });
assert.equal(replies.length, 2, 'conference busy state must also reply');
console.log('PASS: visible busy notifications, atomic call start, active-call preservation, mount-gap busy response, renegotiation, conference rejection.');

const callWindow = fs.readFileSync('src/components/CallWindow.tsx', 'utf8').replace(/\r\n/g, '\n');
const handlerStart = callWindow.indexOf('  handleSignalRef.current = async');
const handler = callWindow.slice(handlerStart, callWindow.indexOf('\n  useEffect(() => {\n    const stableHandler', handlerStart));
const stops = [];
context.handleSignalRef = {};
context._call = { targetId: 'alice', pc: {} };
context.stopCall = (...args) => stops.push(args);
context.sendSignal = message => replies.push(message);
context.tr = key => key;
vm.runInContext(transpile(handler), context);
(async () => {
  await context.handleSignalRef.current({ type: 'call-rejected', from: 'bob', callStatus: 'busy' });
  assert.equal(stops.length, 0, 'another caller must not end the current call');
  await context.handleSignalRef.current({ type: 'call-rejected', from: 'alice', callStatus: 'busy' });
  assert.equal(stops[0][3], true);
  assert.equal(notices.pop(), 'call_msg_busy', 'received busy response must reach visible notifications');
  console.log('PASS: received busy response is visible; unrelated rejection leaves current call active.');
})().catch(error => { console.error(error); process.exitCode = 1; });
