const testRuntime=require('./web-test-runtime.cjs');
// Real WASM SDK against the production Python relay via a stdio test fixture.
// This verifies the protocol, not HTTP routing or a visible browser interface.
const assert = require('node:assert/strict');
const { webcrypto, randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const Module = require('node:module');
const path = require('node:path');
const esbuild = testRuntime.esbuild;
testRuntime.require('fake-indexeddb/auto');
globalThis.crypto = webcrypto;
const locks = new Set();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
  request: async (name, options, callback) => {
    if (locks.has(name)) return callback(null);
    locks.add(name); try { return await callback({ name }); } finally { locks.delete(name); }
  },
} } });
const built = esbuild.buildSync({ stdin: { contents: `
export * from './src/core/mesh/pairwiseCipher';
export * from './src/core/mesh/cipherPolicy';
export * from './src/core/mesh/dmCipherMessage';
export * from './src/core/mesh/cipherRelayClient';
export * from './src/core/mesh/cipherKeyInbox';
export * from './src/core/mesh/dmCipherOutbox';
export * from './src/core/mesh/dmCipherCoordinator';
export * from './src/core/mesh/account';
export * from './src/core/mesh/devices';
export * from './src/core/mesh/entryPoint';`, resolveDir: testRuntime.frontend }, bundle: true,
  packages: 'external', platform: 'node', format: 'cjs', target: 'es2022', write: false });
const loaded = new Module(path.join(testRuntime.frontend,'output/cipher-relay-test.cjs'), module);
loaded.filename = path.join(testRuntime.frontend,'output/cipher-relay-test.cjs'); loaded.paths = testRuntime.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const { PairwiseCipher, AuthorizedCipher, DmCipherMessages, CipherRelayClient, DmCipherOutbox, DmCipherCoordinator, receivePendingDmKeys, signCipherCertificate, meshUserId,
  meshDeviceId, signDeviceEvent, validateTrustedEntryPoints } = loaded.exports;

function fixture() {
  const python = testRuntime.python;
  const child = spawn(python, ['scripts/mesh-cipher-authority-fixture.py'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = []; let errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-8192); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const item = pending.shift(); if (!item) return;
    try { const body = JSON.parse(line); body.error ? item.reject(new Error(body.error)) : item.resolve(body.result); }
    catch (error) { item.reject(error); }
  });
  child.on('error', error => { for (const item of pending.splice(0)) item.reject(error); });
  child.on('exit', code => { for (const item of pending.splice(0)) item.reject(new Error(`fixture exited ${code}: ${errors}`)); });
  return {
    rpc: body => new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(body) + '\n'); }),
    close: async () => { child.stdin.end(); await exited; lines.close(); if (child.exitCode) throw new Error(errors); },
  };
}
function signingKey() {
  const pair = generateKeyPairSync('ed25519');
  return { root: new Uint8Array(pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)),
    public: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };
}
(async () => {
  const backend = fixture(), scope = randomUUID(), people = [], sent = [];
  let lostResponse = false, lostKeyResponse = false;
  let messageOutbox;
  const coordinators = [];
  try {
    for (let index = 0; index < 3; index++) {
      const owner = signingKey(), device = signingKey(), user = randomUUID();
      const identity = { network: 'lab', genesis: 'a'.repeat(64), owner: await meshUserId(owner.public), device: await meshDeviceId(device.public) };
      const person = { owner, device, user, identity };
      person.provider = request => backend.rpc({ operation: 'scope', user, ...request });
      person.request = async request => {
        const proof = await person.provider({ source: 'dm', scope, nonce: randomBytes(32).toString('hex') });
        try { return await backend.rpc({ operation: 'relay', user, source: 'dm', scope, roster: proof.body.roster, epoch: proof.body.epoch, request }); }
        catch (error) {
          const body = JSON.parse(request.body);
          const mail = Object.values(Object.values(body.messages ?? {})[0] ?? {})[0];
          error.message += ` (type=${request.type}, fields=${Object.keys(body)}, device_fields=${Object.keys(body.device_keys ?? {})}, key_fields=${Object.keys(Object.values(body.one_time_keys ?? {})[0] ?? {})}, mail_fields=${Object.keys(mail ?? {})})`;
          throw error;
        }
      };
      person.sdkRelay = async request => {
        sent.push(request.body);
        const result = JSON.parse(await person.channel.relay(request));
        // The key was consumed durably, but its response did not reach the SDK.
        // Exact replay must return that same key, without consuming another.
        if (request.type === 2 && !lostResponse) {
          lostResponse = true;
          assert.deepEqual(JSON.parse(await person.channel.relay(request)), result);
        }
        if (request.type === 3 && !lostKeyResponse) {
          lostKeyResponse = true;
          throw new Error('simulated_lost_key_response');
        }
        return JSON.stringify(result);
      };
      person.storage = index < 2 ? { mode: 'persistent', passphrase: randomBytes(32).toString('hex') } : { mode: 'memory' };
      person.cipher = await PairwiseCipher.open(identity, person.sdkRelay, person.storage);
      people.push(person);
      const certificate = await signCipherCertificate(person.cipher.publicIdentity(), device.public, device.root);
      person.event = await signDeviceEvent(owner.root, owner.public, { domain: 'sfera-mesh-device-event-lab-v1', network: 'lab',
        user_id: identity.owner, version: 1, previous: '0'.repeat(64), operation: 'enroll', device_id: identity.device, device_public: device.public }, device.root);
      person.setup = { user, owner_public: owner.public, event: person.event, certificate, session: randomBytes(32).toString('hex') };
    }
    const [alice, bob, carol] = people;
    const pin = (await validateTrustedEntryPoints([await backend.rpc({ operation: 'setup', users: people.map(person => person.setup), messages: true })]))[0];
    for (const person of people) {
      person.options = { pin, user: person.user, scope, identity: () => person.cipher.publicIdentity(),
        guard: () => {}, review: async () => true,
        post: (route, body) => {
          if (route === '/api/auth/mesh/cipher/scope/') return person.provider(body);
          assert.equal(route, '/api/auth/mesh/cipher/relay/');
          return backend.rpc({ operation: 'relay', user: person.user, ...body });
        } };
      person.channel = new CipherRelayClient(person.options);
    }
    // Keys are device-bound public data. Initial publication uses the currently
    // authorized roster; an outsider is removed before any message is encrypted.
    for (const person of people) await person.cipher.publishKeys();
    await backend.rpc({ operation: 'members', members: [alice.user, bob.user] });
    for (const person of people) {
      person.policy = new AuthorizedCipher(person.cipher, pin, person.user, person.provider, () => {}, async () => true);
      person.dm = new DmCipherMessages(person.policy, person.identity, person.user);
    }
    const id = randomUUID(), replyTo = randomUUID(), text = 'Секрет через серверную очередь ключей';
    await assert.rejects(alice.dm.seal(scope, id, { text, replyTo }), /simulated_lost_key_response/);
    await alice.cipher.close();
    alice.cipher = await PairwiseCipher.open(alice.identity, alice.sdkRelay, alice.storage);
    alice.policy = new AuthorizedCipher(alice.cipher, pin, alice.user, alice.provider, () => {}, async () => true);
    alice.dm = new DmCipherMessages(alice.policy, alice.identity, alice.user);
    const wire = await alice.dm.seal(scope, id, { text, replyTo });
    assert(lostResponse);
    assert(!JSON.stringify(sent).includes(text));
    const poll = () => bob.channel.pending();
    const queued = await poll();
    assert.equal(queued.length, 1);
    assert.deepEqual(await poll(), queued, 'unacknowledged key survives repeated polling');
    await bob.policy.receiveKey('dm', scope, queued[0].sender, queued[0].content);
    await bob.policy.receiveKey('dm', scope, queued[0].sender, queued[0].content);
    // Simulate death after SDK commit, before any local journal or server ACK.
    await bob.cipher.close();
    bob.cipher = await PairwiseCipher.open(bob.identity, bob.sdkRelay, bob.storage);
    bob.policy = new AuthorizedCipher(bob.cipher, pin, bob.user, bob.provider, () => {}, async () => true);
    bob.dm = new DmCipherMessages(bob.policy, bob.identity, bob.user);
    assert.equal((await bob.dm.open(scope, wire)).text, text);
    assert.equal((await bob.dm.open(scope, wire)).replyTo, replyTo);
    const stored = await backend.rpc({ operation: 'store_message', user: alice.user, scope, cipher: wire });
    assert.equal(stored.status, 201, JSON.stringify(stored));
    assert.equal(stored.body.id, id);
    assert.equal(stored.body.message_type, 'cipher');
    assert.equal(stored.body.content, '');
    assert.deepEqual(stored.body.payload, wire);
    assert.equal(stored.body.reply_to, null);
    assert(!JSON.stringify(stored).includes(text));
    assert(!JSON.stringify(stored).includes(replyTo));
    const repeated = await backend.rpc({ operation: 'store_message', user: alice.user, scope, cipher: wire });
    assert.equal(repeated.status, 200);
    const history = await backend.rpc({ operation: 'read_messages', user: bob.user, scope });
    assert.equal(history.status, 200, JSON.stringify(history));
    const rows = Array.isArray(history.body) ? history.body : history.body.messages;
    assert.equal(rows.length, 1);
    assert.equal((await bob.dm.open(scope, rows[0].payload)).text, text);
    const access = await backend.rpc({ operation: 'application_access', user: alice.user });
    const outboxRoot = new Uint8Array(randomBytes(32)), messagePosts = [];
    let seals = 0, lostMessageResponse = true;
    const outboxOptions = { guard: () => true, token: () => access,
      seal: (...args) => { seals++; return alice.dm.seal(...args); },
      transport: async (url, init) => {
        assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
        assert.equal(init.headers['X-Ionik-Client'], '1');
        if (url.endsWith('/api/auth/mesh/entry/')) {
          assert.equal(init.headers.Authorization, undefined);
          return Response.json(await backend.rpc({ operation: 'entry_probe', nonce: JSON.parse(init.body).nonce }));
        }
        assert.equal(url, pin.url + '/api/conversations/' + scope + '/messages/cipher/send/');
        assert.equal(init.headers.Authorization, 'Bearer ' + access);
        messagePosts.push(init.body);
        const result = await backend.rpc({ operation: 'store_message', user: alice.user, scope,
          data: JSON.parse(init.body), authorization: init.headers.Authorization });
        if (lostMessageResponse) { lostMessageResponse = false; throw new Error('simulated_lost_message_response'); }
        return Response.json(result.body, { status: result.status });
      } };
    const openOutbox = () => DmCipherOutbox.open(alice.identity, pin, alice.user, outboxRoot, outboxOptions);
    messageOutbox = await openOutbox();
    const intent = await messageOutbox.create(scope, { text: 'Очередь после потери SQL-ответа', replyTo: id });
    await assert.rejects(messageOutbox.send(intent.id), /simulated_lost_message_response/);
    await messageOutbox.close();
    await alice.cipher.close();
    alice.cipher = await PairwiseCipher.open(alice.identity, alice.sdkRelay, alice.storage);
    alice.policy = new AuthorizedCipher(alice.cipher, pin, alice.user, alice.provider, () => {}, async () => true);
    alice.dm = new DmCipherMessages(alice.policy, alice.identity, alice.user);
    messageOutbox = await openOutbox();
    const accepted = await messageOutbox.send(intent.id);
    assert.equal(accepted.state, 'accepted'); assert.equal(accepted.publication, 'local');
    assert.equal(messagePosts[0], messagePosts[1]); assert.equal(seals, 1);
    assert.equal((await bob.dm.open(scope, accepted.wire)).text, intent.payload.text);
    assert.equal((await bob.dm.open(scope, accepted.wire)).replyTo, id);
    await backend.rpc({ operation: 'enable_delivery' });
    const pendingIntent = await messageOutbox.create(scope, { text: 'Очередь ждёт подтверждённой доставки', replyTo: null });
    const pending = await messageOutbox.send(pendingIntent.id);
    assert.equal(pending.state, 'pending'); assert.equal(pending.publication, 'pending');
    await messageOutbox.close(); messageOutbox = await openOutbox();
    assert.equal((await messageOutbox.send(pending.id)).state, 'pending');
    const confirmedModel = await backend.rpc({ operation: 'confirm_delivery' });
    assert.equal(confirmedModel.count, 1);
    const complete = await messageOutbox.send(pending.id);
    assert.equal(complete.state, 'accepted'); assert.equal(complete.publication, 'confirmed');
    assert.equal((await bob.dm.open(scope, complete.wire)).text, pendingIntent.payload.text);
    assert(messagePosts.slice(2).every(body => body === messagePosts[2]));
    assert.equal(seals, 2);
    await messageOutbox.close(); messageOutbox = undefined; outboxRoot.fill(0);
    const changedPacket = structuredClone(queued[0].content);
    const ciphertext = Object.values(changedPacket.ciphertext)[0];
    ciphertext.body = ciphertext.body.slice(0, -1) + (ciphertext.body.endsWith('A') ? 'B' : 'A');
    await assert.rejects(bob.policy.receiveKey('dm', scope, queued[0].sender, changedPacket), /receipt_context_mismatch/);
    const changedProbe = structuredClone(queued[0].content); changedProbe.key_receipt.sender_device = bob.identity.device;
    await assert.rejects(bob.policy.receiveKey('dm', scope, queued[0].sender, changedProbe), /invalid_group_key_receipt/);
    const invalidCipher = structuredClone(queued[0].content); invalidCipher.key_receipt.content.ciphertext = 'QUJD';
    await assert.rejects(bob.policy.receiveKey('dm', scope, queued[0].sender, invalidCipher));
    let unsafeAcks = 0;
    const legacy = structuredClone(queued[0]); delete legacy.content.key_receipt;
    await assert.rejects(receivePendingDmKeys(bob.policy, { pending: async () => [legacy],
      acknowledge: async () => { unsafeAcks++; } }, scope), /receipt_required/);
    assert.equal(unsafeAcks, 0);
    const beforeAck = new CipherRelayClient({ ...bob.options,
      post: (route, body) => route.endsWith('/relay/') && body.request.type === 5 ?
        Promise.reject(new Error('simulated_before_ack')) : bob.options.post(route, body) });
    await assert.rejects(receivePendingDmKeys(bob.policy, beforeAck, scope), /simulated_before_ack/);
    assert.equal((await poll()).length, 1);
    await bob.cipher.close();
    bob.cipher = await PairwiseCipher.open(bob.identity, bob.sdkRelay, bob.storage);
    bob.policy = new AuthorizedCipher(bob.cipher, pin, bob.user, bob.provider, () => {}, async () => true);
    bob.dm = new DmCipherMessages(bob.policy, bob.identity, bob.user);
    const afterAck = new CipherRelayClient({ ...bob.options,
      post: async (route, body) => {
        const result = await bob.options.post(route, body);
        if (route.endsWith('/relay/') && body.request.type === 5) throw new Error('simulated_lost_ack_response');
        return result;
      } });
    await assert.rejects(receivePendingDmKeys(bob.policy, afterAck, scope), /simulated_lost_ack_response/);
    assert.deepEqual(await poll(), []);
    assert.equal(await receivePendingDmKeys(bob.policy, bob.channel, scope), 0);
    assert.equal((await bob.dm.open(scope, wire)).text, text);
    await assert.rejects(receivePendingDmKeys(carol.policy, carol.channel, scope), /persistent_cipher_store_required/);
    const denied = new CipherRelayClient({ ...bob.options, review: async () => false });
    await assert.rejects(denied.pending(), /approval_required/);
    let active = true;
    const switched = new CipherRelayClient({ ...bob.options,
      guard: () => { if (!active) throw new Error('context_changed'); },
      post: async (route, body) => { const result = await bob.options.post(route, body); active = false; return result; } });
    await assert.rejects(switched.pending(), /context_changed/);
    const malformed = new CipherRelayClient({ ...bob.options,
      post: (route, body) => route.endsWith('/relay/') ? Promise.resolve({ messages: [{ text: 'unsafe' }] }) : bob.options.post(route, body) });
    await assert.rejects(malformed.pending(), /response/);
    await assert.rejects(carol.request({ id: randomUUID(), type: 4, body: '{}' }));
    await assert.rejects(carol.dm.open(scope, wire));
    // One persistent device SDK serves two scopes. Force an asynchronous gap
    // in every HTTP exchange so concurrent callers would expose a shared-route race.
    const secondScope = randomUUID(), deniedScope = randomUUID();
    await backend.rpc({ operation: 'members', scope: secondScope, members: [alice.user, bob.user, carol.user] });
    await backend.rpc({ operation: 'members', scope: deniedScope, members: [alice.user, bob.user] });
    await alice.cipher.close(); await bob.cipher.close();
    const routes = [];
    const runtime = async (person, control = {}) => {
      const coordinator = await DmCipherCoordinator.open(person.identity, pin, person.user, person.storage.passphrase, {
        guard: () => control.active !== false,
        token: () => { control.tokenReads = (control.tokenReads ?? 0) + 1; return 'fixture-token'; },
        review: async body => {
          if (control.hold) { control.entered(); await control.hold; }
          return body.scope !== deniedScope;
        },
        transport: async (url, init) => {
          await new Promise(resolve => setImmediate(resolve));
          const body = JSON.parse(init.body);
          if (url.endsWith('/entry/')) {
            assert.equal(init.headers.Authorization, undefined);
            return Response.json(await backend.rpc({ operation: 'entry_probe', nonce: control.wrongProbe ? '0'.repeat(64) : body.nonce }));
          }
          assert.equal(init.headers.Authorization, 'Bearer fixture-token');
          routes.push({ user: person.user, scope: body.scope, type: body.request?.type });
          const operation = url.endsWith('/scope/') ? 'scope' : 'relay';
          return Response.json(await backend.rpc({ operation, user: person.user, ...body }));
        },
      });
      coordinators.push(coordinator); return coordinator;
    };
    const sender = await runtime(alice), receiver = await runtime(bob);
    assert.deepEqual(sender.publicIdentity(), senderIdentity(alice));
    const draft = { text: 'first scope', replyTo: null };
    const sends = [sender.seal(scope, randomUUID(), draft),
      sender.seal(secondScope, randomUUID(), { text: 'second scope', replyTo: null })];
    draft.text = 'caller mutation';
    const [firstWire, secondWire] = await Promise.all(sends);
    assert.notEqual(firstWire.envelope.room, secondWire.envelope.room);
    await Promise.all([receiver.receiveKeys(scope), receiver.receiveKeys(secondScope)]);
    const opened = await Promise.all([receiver.openMessage(secondScope, secondWire), receiver.openMessage(scope, firstWire)]);
    assert.deepEqual(opened.map(item => item.text), ['second scope', 'first scope']);
    await assert.rejects(receiver.openMessage(secondScope, firstWire), /context_mismatch/);
    const beforeDenied = routes.length;
    await assert.rejects(sender.seal(deniedScope, randomUUID(), { text: 'denied', replyTo: null }), /approval_required/);
    assert(!routes.slice(beforeDenied).some(item => item.type !== undefined), 'denied roster must not reach SDK relay');
    // Failed scope must release the outer operation, preserving later work.
    const recovered = await sender.seal(scope, randomUUID(), { text: 'after denial', replyTo: null });
    assert.equal((await receiver.openMessage(scope, recovered)).text, 'after denial');
    const aliceScopes = routes.filter(item => item.user === alice.user && item.type === 3).map(item => item.scope);
    assert(aliceScopes.includes(secondScope));
    await sender.close();
    await assert.rejects(sender.seal(scope, randomUUID(), { text: 'closed', replyTo: null }), /closed/);
    const control = { wrongProbe: true, tokenReads: 0 };
    await assert.rejects(runtime(alice, control), /entry_probe_context_mismatch/);
    assert.equal(control.tokenReads, 0, 'no JWT read before valid anonymous entry proof');
    control.wrongProbe = false;
    const restarted = await runtime(alice, control);
    assert.deepEqual(restarted.publicIdentity(), senderIdentity(alice));
    let releaseReview, enteredReview;
    control.hold = new Promise(resolve => { releaseReview = resolve; });
    const entered = new Promise(resolve => { enteredReview = resolve; });
    control.entered = enteredReview;
    const interrupted = restarted.seal(scope, randomUUID(), { text: 'interrupted', replyTo: null });
    const waiting = restarted.seal(secondScope, randomUUID(), { text: 'waiting', replyTo: null });
    const interruptedCheck = assert.rejects(interrupted, /closed/), waitingCheck = assert.rejects(waiting, /closed/);
    await entered;
    const beforeClose = routes.length, closing = restarted.close();
    releaseReview();
    await Promise.all([interruptedCheck, waitingCheck, closing]);
    assert.equal(routes.length, beforeClose, 'closing during review must prevent further HTTP/SDK work');
    await receiver.close();
    await backend.rpc({ operation: 'available', value: false });
    await assert.rejects(runtime(alice), /offline/);
    console.log('Production cipher transport passed: real SDK, multi-chat coordinator concurrency/restart/review isolation, encrypted IndexedDB outbox, real JWT/DRF history, 202 retries, key/ACK retries, tamper/ACL/outage guards.');
  } finally {
    for (const coordinator of coordinators) await coordinator.close();
    await messageOutbox?.close();
    for (const person of people) { await person.cipher.close(); person.owner.root.fill(0); person.device.root.fill(0); }
    await backend.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

function senderIdentity(person) {
  return { ...person.identity, ed25519: person.setup.certificate.body.ed25519,
    curve25519: person.setup.certificate.body.curve25519 };
}
