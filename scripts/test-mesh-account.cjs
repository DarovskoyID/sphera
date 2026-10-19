const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');
globalThis.crypto = webcrypto;
function load(entry, name) {
  const result = esbuild.buildSync({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const loaded = new Module(path.resolve('output/' + name), module);
  loaded.filename = path.resolve('output/' + name);
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, loaded.filename);
  return loaded.exports;
}
const account = load('src/core/mesh/account.ts', 'mesh-account-test.cjs');
const { changeVaultPassword } = load('src/core/mesh/vault.ts', 'mesh-account-vault-test.cjs');
(async () => {
  // Public interoperability fixture: Python cryptography, Ed25519 seed bytes 0..31.
  const fixture = { body: { domain: 'sfera-mesh-account-v1', network: 'lab', user_id: '1276f792ea17f70a39cddf267f9be2ddba84d863a50a617bf953e2afbbcdb5a0', public_key: '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8', version: 1, previous: '0'.repeat(64), vault_digest: '1'.repeat(64), dialogs_digest: '2'.repeat(64) }, signature: 'f1955a345a16f615a9359e8ab2c33be16db5d8402fcebcb4dd4a084050a6d4fd29e1e92653167ed849f60256d7892483dc6b79c18543c23a44acf94c610b3606' };
  await account.verifyAccount(fixture, 'lab', fixture.body.user_id);
  assert.deepEqual(await account.signAccount(Uint8Array.from({ length: 32 }, (_, i) => i), fixture.body), fixture);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Client key code must not transmit anything'); };
  let first, otherDevice, restored;
  try {
    first = await account.createMeshAccount('first-long-password', 'lab', '2'.repeat(64));
    assert.equal(first.userId, first.record.body.user_id);
    assert.equal(first.vault.userId, first.userId);
    const firstHash = await account.verifyAccount(first.record, 'lab', first.userId);
    otherDevice = await account.openMeshAccount(JSON.parse(JSON.stringify(first.record)), new Uint8Array(first.vaultBytes), 'first-long-password', 'lab', first.userId);
    assert.deepEqual(otherDevice, first.root);
    await assert.rejects(account.openMeshAccount(first.record, first.vaultBytes, 'wrong-password', 'lab', first.userId));
    await assert.rejects(account.openMeshAccount(first.record, first.vaultBytes, 'first-long-password', 'other-network', first.userId));
    await assert.rejects(account.openMeshAccount(first.record, first.vaultBytes, 'first-long-password', 'lab', '0'.repeat(64)));
    const tampered = structuredClone(first.record);
    tampered.body.vault_digest = '0'.repeat(64);
    await assert.rejects(account.verifyAccount(tampered, 'lab', first.userId));
    const changed = await changeVaultPassword(first.vault, first.userId, 'first-long-password', 'second-long-password');
    const next = await account.accountRecord(otherDevice, first.publicKey, 'lab', changed, '3'.repeat(64), 2, firstHash);
    assert.equal(next.record.body.previous, firstHash);
    restored = await account.openMeshAccount(next.record, next.vaultBytes, 'second-long-password', 'lab', first.userId);
    assert.deepEqual(restored, first.root);
    await assert.rejects(account.openMeshAccount(next.record, first.vaultBytes, 'first-long-password', 'lab', first.userId));
    await assert.rejects(account.signAccount(new Uint8Array(32), first.record.body));
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of [first?.root, otherDevice, restored]) key?.fill(0);
  }
  console.log('PASS: Python/client signed account compatibility, distributed vault binding, new device and password change without identity replacement.');
})().catch(error => { console.error(error); process.exitCode = 1; });
