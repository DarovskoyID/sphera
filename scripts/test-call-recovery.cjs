const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const context = { exports: {} };
vm.createContext(context);
vm.runInContext(ts.transpileModule(fs.readFileSync('src/utils/callRecovery.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
const { CallRecovery } = context.exports;
function rig() {
  let now = 0, visible = true, attempts = 0, failed = 0, sequence = 0;
  const timers = new Map(), states = [];
  let attempt = async () => {};
  const recovery = new CallRecovery({
    attempt: () => { attempts++; return attempt(); },
    onState: state => states.push(state), onFailed: () => failed++,
    now: () => now, visible: () => visible,
    schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    cancel: id => timers.delete(id),
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { recovery, states, timers, get attempts() { return attempts; }, get failed() { return failed; },
    setVisible(value) { visible = value; }, setAttempt(value) { attempt = value; },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = until; await flush();
    },
  };
}
(async () => {
  let r = rig(); r.recovery.recover(); r.recovery.recover();
  assert.equal(r.attempts, 1, 'duplicate disconnects must not start parallel attempts');
  await r.advance(44_999); assert.equal(r.failed, 0);
  await r.advance(1); assert.equal(r.failed, 1); assert.equal(r.timers.size, 0);
  r.recovery.recover(); assert.equal(r.failed, 1);

  r = rig(); r.recovery.recover(); await r.advance(5_000); r.recovery.connected();
  const count = r.attempts; await r.advance(90_000);
  assert.equal(r.attempts, count); assert.equal(r.failed, 0); assert.equal(r.states.at(-1), 'connected');

  r = rig(); r.recovery.recover(); r.recovery.suspend(); r.setVisible(false);
  await r.advance(300_000); assert.equal(r.failed, 0, 'background time must not exhaust foreground retry budget');
  r.setVisible(true); r.recovery.recover(true); await r.advance(40_000); assert.equal(r.failed, 0);
  r.recovery.connected(); await r.advance(10_000); assert.equal(r.failed, 0);

  r = rig(); r.setAttempt(() => new Promise(() => {})); r.recovery.recover(); await r.advance(45_000);
  assert.equal(r.attempts, 1); assert.equal(r.failed, 1, 'a hanging media request must not keep a ghost call forever');

  r = rig(); r.recovery.connecting(); assert.equal(r.states.at(-1), 'connecting'); assert.equal(r.attempts, 0);
  await r.advance(45_000); assert.equal(r.failed, 1);

  r = rig(); r.recovery.recover(); r.recovery.stop(); await r.advance(90_000);
  assert.equal(r.failed, 0); assert.equal(r.timers.size, 0);
  console.log('PASS: bounded recovery, duplicate events, success cancels retries, background/resume grace, hanging capture timeout, initial connect timeout, hangup cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const source = fs.readFileSync('src/components/CallWindow.tsx', 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('  handleSignalRef.current = async');
  const body = source.slice(start, source.indexOf('\n  useEffect(() => {\n    const stableHandler', start));
  function peer(own, remote) {
    const sent = [], operations = [];
    const pc = {
      signalingState: 'have-local-offer',
      async setLocalDescription(description) { operations.push(description.type); this.signalingState = description.type === 'rollback' ? 'stable' : 'stable'; },
      async setRemoteDescription(description) { operations.push(`remote:${description.type}`); this.signalingState = description.type === 'answer' ? 'stable' : 'have-remote-offer'; },
      async createAnswer() { return { type: 'answer' }; },
      async addIceCandidate() { operations.push('candidate'); },
    };
    const sandbox = {
      handleSignalRef: {}, _call: { pc, targetId: remote, pendingCandidates: [], negotiation: 0, wasConnected: true },
      currentUser: { id: own }, sendSignal: message => sent.push(message), addLocalTracks() {},
      RTCSessionDescription: function(description) { return description; },
      RTCIceCandidate: function(candidate) { return candidate; },
    };
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    return { sandbox, sent, operations, handle: sandbox.handleSignalRef.current };
  }
  let p = peer('2', '1');
  await p.handle({ type: 'offer', from: '1', sdp: { type: 'offer' }, recovery: true });
  assert.deepEqual(p.operations, ['rollback', 'remote:offer', 'answer']);
  assert.equal(p.sent[0].type, 'answer');
  p = peer('1', '2');
  await p.handle({ type: 'offer', from: '2', sdp: { type: 'offer' }, recovery: true });
  assert.equal(p.sandbox._call.ignoreOffer, true); assert.equal(p.operations.length, 0);
  await p.handle({ type: 'answer', from: '2', sdp: { type: 'answer' } });
  assert.equal(p.sandbox._call.ignoreOffer, false);
  await p.handle({ type: 'call-resume', from: 'stranger' });
  assert.equal(p.sent.at(-1).type, 'call-end', 'a stale recovery must not resurrect an ended call');
  console.log('PASS: simultaneous recovery offers use deterministic rollback/ignore; answers resume ICE candidates; stale recovery is rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const source = fs.readFileSync('src/components/CallWindow.tsx', 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf('  useEffect(() => {\n    let lastBytes:');
  const effect = source.slice(begin, source.indexOf('  // ==================== UI', begin));
  let clock = 0, bytes = 100, tick, disposed;
  const actions = [];
  const pc = { connectionState: 'connected', iceConnectionState: 'connected', async getStats() { return new Map([['audio', { type: 'inbound-rtp', bytesReceived: bytes }]]); } };
  const call = { pc, targetId: 'alice', wasConnected: true, mediaStalled: false, audioStream: { getAudioTracks: () => [{ readyState: 'live', muted: false }] }, recovery: {
    recover: resumed => actions.push(resumed ? 'resume' : 'recover'), connected: () => actions.push('connected'), suspend: () => actions.push('suspend'),
  } };
  const listeners = new Map();
  const sandbox = { _call: call, Date: { now: () => clock }, useEffect: callback => { disposed = callback(); },
    setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {},
    document: { visibilityState: 'visible', addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} }, sendSignal: () => actions.push('signal'), attachRemoteStream() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  const inspect = async () => { tick(); for (let i = 0; i < 8; i++) await Promise.resolve(); };
  await inspect(); clock = 20_000; await inspect();
  assert.equal(call.mediaStalled, true); assert.equal(actions.at(-1), 'recover');
  bytes = 300; clock += 5_000; await inspect();
  assert.equal(call.mediaStalled, false); assert.equal(actions.at(-1), 'connected');
  sandbox.document.visibilityState = 'hidden'; listeners.get('visibilitychange')(); assert.equal(actions.at(-1), 'suspend');
  sandbox.document.visibilityState = 'visible'; listeners.get('visibilitychange')(); assert.equal(actions.at(-1), 'resume');
  assert.ok(actions.includes('signal')); disposed();
  console.log('PASS: missing media triggers recovery despite connected ICE; fresh RTP restores state; screen unlock resumes signaling and playback.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const source = fs.readFileSync('src/components/CallWindow.tsx', 'utf8').replace(/\r\n/g, '\n');
  const begin = source.indexOf('  const repairMedia = async');
  const body = source.slice(begin, source.indexOf('  _call.recoveryAttempt =', begin));
  const oldAudio = { kind: 'audio', readyState: 'ended', stop() { this.stopped = true; } };
  const oldVideo = { kind: 'video', readyState: 'ended', stop() { this.stopped = true; } };
  const newAudio = { kind: 'audio', enabled: false, stop() {} }, newVideo = { kind: 'video', enabled: true, stop() {} };
  const replaced = [], constraints = [];
  const pc = { getSenders: () => [{ track: oldAudio, replaceTrack: async track => replaced.push(track) }, { track: oldVideo, replaceTrack: async track => replaced.push(track) }] };
  const Stream = function(tracks) { this.getTracks = () => tracks; };
  const call = { pc, generation: 1, audioStream: new Stream([oldAudio]), cameraStream: new Stream([oldVideo]) };
  const sandbox = { _call: call, MediaStream: Stream, document: { visibilityState: 'visible' }, isVideoActiveRef: { current: true }, cameraVideoRef: { current: null }, setLocalVideoStatus() {}, attachStreamToVideo() {},
    acquireCallMedia: async options => { constraints.push(options); return new Stream([newAudio, newVideo]); },
  };
  vm.createContext(sandbox);
  vm.runInContext(ts.transpileModule(body + '\nglobalThis.repairMedia = repairMedia;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  await sandbox.repairMedia();
  assert.equal(constraints[0].audio, true); assert.equal(constraints[0].video, true);
  assert.equal(replaced[0], newAudio); assert.equal(replaced[1], newVideo);
  assert.equal(call.audioStream.getTracks()[0].enabled, false, 'restored microphone must stay muted');
  assert.equal(oldAudio.stopped, true); assert.equal(oldVideo.stopped, true);
  sandbox.document.visibilityState = 'hidden'; await sandbox.repairMedia(); assert.equal(constraints.length, 1);
  console.log('PASS: stopped microphone/camera are replaced on senders; old tracks stop; mute preserved; hidden page does not reopen camera.');
})().catch(error => { console.error(error); process.exitCode = 1; });
