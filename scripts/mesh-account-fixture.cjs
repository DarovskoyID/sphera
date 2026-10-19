// Public test fixture only; no production account, password or root key is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
globalThis.crypto = require('node:crypto').webcrypto;
const built = esbuild.buildSync({ stdin: { contents: "export * from './src/core/mesh/account'; export * from './src/core/mesh/vault';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs' });
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
      process.stdout.write(JSON.stringify({ opened: true, user_id: input.expectedUser }));
    } finally { root.fill(0); }
  } else { throw new Error('Unknown test mode'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
