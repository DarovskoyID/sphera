// Public test fixture only; no production account, password or root key is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
globalThis.crypto = require('node:crypto').webcrypto;
const built = esbuild.buildSync({ stdin: { contents: "export * from './src/core/mesh/account'; export * from './src/core/mesh/vault'; export * from './src/core/mesh/auth';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs' });
const loaded = new Module(path.resolve('output/mesh-account-fixture.cjs'), module);
loaded.filename = path.resolve('output/mesh-account-fixture.cjs');
loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const api = loaded.exports;
const password = 'disposable-mesh-integration-password';
const encode = value => Buffer.from(value).toString('hex');
const decode = value => new Uint8Array(Buffer.from(value, 'hex'));
const plaintext = 'Disposable encrypted archive message';
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.mode === 'create') {
    const account = await api.createMeshAccount(password, 'lab', '0'.repeat(64));
    try {
      const archive = await api.encryptArchive(account.root, account.userId, 'dialog-1', 'message-1', new TextEncoder().encode(plaintext));
      const archiveBytes = api.accountBytes(archive);
      const indexPlain = api.accountBytes({ messages: [{ dialogId: 'dialog-1', messageId: 'message-1', digest: await api.accountDigest(archiveBytes) }] });
      const index = await api.encryptArchive(account.root, account.userId, '__mesh_index__', 'index-v1', indexPlain);
      const indexBytes = api.accountBytes(index);
      const result = await api.accountRecord(account.root, account.publicKey, 'lab', account.vault, await api.accountDigest(indexBytes));
      process.stdout.write(JSON.stringify({ record: result.record, vault_hex: encode(result.vaultBytes), index_hex: encode(indexBytes), archive_hex: encode(archiveBytes) }));
    } finally { account.root.fill(0); }
  } else if (input.mode === 'open') {
    let challenge, clientNonce;
    async function authRequest(operation, body, token) {
      assert.match(input.entry.endpoint, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
      const response = await fetch(input.entry.endpoint + '/mesh-lab/auth/' + operation, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
      if (!response.ok) { await response.arrayBuffer(); throw new Error('Lab authentication rejected: ' + response.status); }
      return response.json();
    }
    if (input.entry) {
      clientNonce = api.loginNonce();
      challenge = await authRequest('challenge', { user_id: input.expectedUser, client_nonce: clientNonce });
      await api.verifyLoginChallenge(challenge, input.entry.pin, input.record, input.expectedUser, clientNonce);
      const forged = structuredClone(challenge); forged.signature = '0'.repeat(128);
      await assert.rejects(api.verifyLoginChallenge(forged, input.entry.pin, input.record, input.expectedUser, clientNonce));
      await assert.rejects(api.verifyLoginChallenge(challenge, input.entry.pin, input.record, input.expectedUser, clientNonce, challenge.body.expires_at));
      await assert.rejects(api.verifyLoginChallenge(challenge, { ...input.entry.pin, nodeId: '0'.repeat(64) }, input.record, input.expectedUser, clientNonce));
      await assert.rejects(api.verifyLoginChallenge(challenge, input.entry.pin, input.record, input.expectedUser, api.loginNonce()));
    }
    const root = await api.openMeshAccount(input.record, decode(input.vault_hex), password, 'lab', input.expectedUser);
    try {
      const indexBytes = decode(input.index_hex);
      assert.equal(await api.accountDigest(indexBytes), input.record.body.dialogs_digest);
      const index = JSON.parse(new TextDecoder().decode(await api.decryptArchive(root, input.expectedUser, '__mesh_index__', 'index-v1', JSON.parse(Buffer.from(indexBytes).toString('utf8')))));
      const item = index.messages[0];
      const archiveBytes = decode(input.archive_hex);
      assert.equal(await api.accountDigest(archiveBytes), item.digest);
      const message = JSON.parse(Buffer.from(archiveBytes).toString('utf8'));
      const recovered = await api.decryptArchive(root, input.expectedUser, item.dialogId, item.messageId, message);
      assert.equal(new TextDecoder().decode(recovered), plaintext);
      let authenticated = false;
      if (input.entry) {
        await assert.rejects(api.answerLogin(new Uint8Array(32), challenge, input.entry.pin, input.record, input.expectedUser, clientNonce));
        const proof = await api.answerLogin(root, challenge, input.entry.pin, input.record, input.expectedUser, clientNonce);
        const response = await authRequest('complete', proof);
        const session = await api.verifyLoginSession(response, input.entry.pin, challenge, input.record, input.expectedUser, clientNonce);
        await assert.rejects(api.verifyLoginSession(response, input.entry.pin, challenge, input.record, input.expectedUser, clientNonce, response.body.expires_at));
        const tampered = structuredClone(response); tampered.body.scope = 'admin';
        await assert.rejects(api.verifyLoginSession(tampered, input.entry.pin, challenge, input.record, input.expectedUser, clientNonce));
        await assert.rejects(authRequest('complete', proof));
        if (input.other_entry) {
          assert.match(input.other_entry, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
          const other = await fetch(input.other_entry + '/mesh-lab/auth/session', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token }, body: JSON.stringify({ client_nonce: api.loginNonce() }) });
          assert.equal(other.status, 401);
          await other.arrayBuffer();
        }
        const stateNonce = api.loginNonce();
        const state = await authRequest('session', { client_nonce: stateNonce }, session.token);
        await api.verifySessionState(state, input.entry.pin, input.expectedUser, session.session_id, stateNonce);
        const logoutNonce = api.loginNonce();
        const logout = await authRequest('logout', { client_nonce: logoutNonce }, session.token);
        await api.verifyLogout(logout, input.entry.pin, input.expectedUser, session.session_id, logoutNonce);
        await assert.rejects(api.verifyLogout(logout, input.entry.pin, input.expectedUser, session.session_id, api.loginNonce()));
        await assert.rejects(authRequest('session', { client_nonce: api.loginNonce() }, session.token));
        authenticated = true;
      }
      process.stdout.write(JSON.stringify({ opened: true, user_id: input.expectedUser, ...(input.entry ? { authenticated, revoked: true } : {}) }));
    } finally { root.fill(0); }
  } else { throw new Error('Unknown test mode'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
