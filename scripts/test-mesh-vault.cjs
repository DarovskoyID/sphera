const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');
globalThis.crypto = webcrypto;
const result = esbuild.buildSync({ entryPoints: ['src/core/mesh/vault.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const loaded = new Module(path.resolve('output/mesh-vault-test.cjs'), module);
loaded.paths = module.paths;
loaded.filename = path.resolve('output/mesh-vault-test.cjs');
loaded._compile(result.outputFiles[0].text, loaded.filename);
const { createVault, unlockVault, changeVaultPassword, encryptArchive, decryptArchive } = loaded.exports;
(async () => {
  // Cross-implementation fixture generated with cryptography Argon2id + AESGCM,
  // not the JS implementation under test. Public test material only.
  const fixture = { version: 1, profile: 'argon2id-64m-t3-p1', userId: 'reference-user', salt: '000102030405060708090a0b0c0d0e0f', nonce: '000102030405060708090a0b', wrappedRoot: '2eca92f798deab85c68e68e34c2f7271fc40e21dc3233de96d9d77e1ec59f4487557fc1f62c3f918889f62ac208fb81d' };
  assert.deepEqual(await unlockVault(fixture, 'reference-user', 'reference-test-password'), Uint8Array.from({ length: 32 }, (_, i) => i));
  const first = await createVault('user-1', 'first-long-password');
  const second = await createVault('user-1', 'first-long-password');
  assert.notDeepEqual(first.root, second.root);
  // JSON roundtrip models receiving the encrypted key on another device/server.
  const anotherDevice = await unlockVault(JSON.parse(JSON.stringify(first.vault)), 'user-1', 'first-long-password');
  assert.deepEqual(anotherDevice, first.root);
  await assert.rejects(unlockVault(first.vault, 'user-2', 'first-long-password'));
  await assert.rejects(unlockVault(first.vault, 'user-1', 'wrong-password'));
  await assert.rejects(unlockVault({ ...first.vault, profile: 'attacker-expensive-profile' }, 'user-1', 'first-long-password'));
  const plaintext = new TextEncoder().encode('Private archive message');
  const message = await encryptArchive(first.root, 'user-1', 'dialog-1', 'message-1', plaintext);
  assert.deepEqual(await decryptArchive(anotherDevice, 'user-1', 'dialog-1', 'message-1', message), plaintext);
  await assert.rejects(decryptArchive(anotherDevice, 'user-1', 'dialog-2', 'message-1', message));
  await assert.rejects(decryptArchive(second.root, 'user-1', 'dialog-1', 'message-1', message));
  const corrupted = { ...message, ciphertext: (message.ciphertext.startsWith('00') ? '01' : '00') + message.ciphertext.slice(2) };
  await assert.rejects(decryptArchive(anotherDevice, 'user-1', 'dialog-1', 'message-1', corrupted));
  const changed = await changeVaultPassword(first.vault, 'user-1', 'first-long-password', 'second-long-password');
  await assert.rejects(unlockVault(changed, 'user-1', 'first-long-password'));
  const restored = await unlockVault(changed, 'user-1', 'second-long-password');
  assert.deepEqual(restored, first.root);
  assert.deepEqual(await decryptArchive(restored, 'user-1', 'dialog-1', 'message-1', message), plaintext);
  for (const key of [first.root, second.root, anotherDevice, restored]) key.fill(0);
  console.log('PASS: Argon2id client vault, new device, password rotation, archive context and tamper protection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
