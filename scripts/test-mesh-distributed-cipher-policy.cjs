const testRuntime=require('./web-test-runtime.cjs');
// Real WASM ciphers + Python authority + encrypted IndexedDB. No external services.
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
export * from './src/core/mesh/cipherArchive';
export * from './src/core/mesh/recoveryClient';
export { assembleArchiveDeletion } from './src/core/mesh/archiveDeletion';
export * from './src/core/mesh/applicationProfiles';
export * from './src/core/mesh/applicationDialogs';
export * from './src/core/mesh/account';
export * from './src/core/mesh/devices';
export * from './src/core/mesh/entryPoint';`, resolveDir: testRuntime.frontend }, bundle: true,
  packages: 'external', platform: 'node', format: 'cjs', target: 'es2022', write: false });
const loaded = new Module(path.join(testRuntime.frontend,'output/cipher-policy-test.cjs'), module);
loaded.filename = path.join(testRuntime.frontend,'output/cipher-policy-test.cjs'); loaded.paths = testRuntime.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const { PairwiseCipher, AuthorizedCipher, DmCipherMessages, parseDmCipherMessage, CipherArchive, RecoveryClient, assembleArchiveDeletion, signCipherCertificate, verifyCipherCertificate,
  verifyCipherScope, cipherUserId, accountBytes, accountDigest, meshUserId, meshDeviceId,
  applicationUserId, initialApplicationProfile, initialApplicationDialog, applicationDialogId, applicationConversationId, signDeviceEvent, validateTrustedEntryPoints, personalArchiveRoot, signIdentityStatement } = loaded.exports;
const { relay, transmissions, mailbox } = require('./mesh-e2ee-relay-fixture.cjs')(cipherUserId);
const python = testRuntime.python;
function fixture() {
  const child = spawn(python, ['scripts/mesh-cipher-authority-fixture.py'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = []; let errors = '';
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stderr.on('data', data => { errors = (errors + data).slice(-8192); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const item = pending.shift();
    if (!item) return;
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
const take = identity => mailbox.get(`${cipherUserId(identity)}/${identity.device}`)?.shift()?.content;
async function person(persistent = false) {
  const owner = signingKey(), device = signingKey(), user = randomUUID();
  const identity = { network: 'lab', genesis: 'a'.repeat(64), owner: await meshUserId(owner.public), device: await meshDeviceId(device.public) };
  const storage = persistent ? { mode: 'persistent', passphrase: randomBytes(32).toString('hex') } : { mode: 'memory' };
  const cipher = await PairwiseCipher.open(identity, relay(identity), storage);
  const peer = cipher.publicIdentity();
  const certificate = await signCipherCertificate(peer, device.public, device.root);
  const event = await signDeviceEvent(owner.root, owner.public, { domain: 'sfera-mesh-device-event-lab-v1', network: 'lab',
    user_id: identity.owner, version: 1, previous: '0'.repeat(64), operation: 'enroll', device_id: identity.device, device_public: device.public }, device.root);
  await cipher.publishKeys();
  return { owner, device, user, identity, storage, cipher, peer, certificate, event,
    setup: { user, owner_public: owner.public, event, certificate, session: randomBytes(32).toString('hex') } };
}

// Shared in-memory SDK transport is a test adapter, not the distributed backend.
(async () => {
  const first=fixture(), second=fixture(); let alice,bob;
  try {
    alice=await person(); bob=await person();
    for (const [index,p] of [alice,bob].entries()) {
      p.user=await applicationUserId('lab',p.identity.owner);p.setup.user=p.user;
      p.setup.profile=await initialApplicationProfile(p.owner.root,p.owner.public,'lab','a'.repeat(64),'person'+index,'Тест');
    }
    const dialog=await initialApplicationDialog(alice.owner.root,alice.owner.public,'lab','a'.repeat(64),bob.identity.owner);
    const scope=applicationConversationId(await applicationDialogId('lab',dialog.body.members));
    const setup={operation:'setup',distributed:true,users:[alice.setup,bob.setup],dialog};
    const pinA=await first.rpc(setup),pinB=await second.rpc(setup);
    const commandBody={domain:'sfera-mesh-application-key-v1',network:'lab',genesis:'a'.repeat(64),
      owner:alice.identity.owner,device:alice.identity.device,devices_version:1,request:'sdk-claim-1',kind:'claim',
      dialog:await applicationDialogId('lab',dialog.body.members),target_owner:bob.identity.owner,target_device:bob.identity.device,keys_utf8:''};
    const pendingCommand=alice.cipher.signApplicationKeyCommand(commandBody);
    commandBody.request='mutated-after-sign-start';
    const signedCommand=await pendingCommand;
    assert.equal(signedCommand.body.request,'sdk-claim-1');
    const sdkPublic=await crypto.subtle.importKey('raw',Buffer.from(alice.peer.ed25519,'base64'),'Ed25519',false,['verify']);
    assert(await crypto.subtle.verify('Ed25519',sdkPublic,Buffer.from(signedCommand.signature,'base64'),accountBytes(signedCommand.body)));
    await assert.rejects(alice.cipher.signApplicationKeyCommand({...commandBody,owner:bob.identity.owner}),/actor_mismatch/);
    assert.notEqual(pinA.nodeId,pinB.nodeId);
    const provider=(entry,p)=>request=>entry.rpc({operation:'scope',user:p.user,...request});
    const a=new AuthorizedCipher(alice.cipher,pinA,alice.user,provider(first,alice),()=>{},async()=>true);
    const b=new AuthorizedCipher(bob.cipher,pinB,bob.user,provider(second,bob),()=>{},async()=>true);
    const nonce='e'.repeat(64);
    const proofA=await provider(first,alice)({source:'dm',scope,nonce});
    const proofB=await provider(second,bob)({source:'dm',scope,nonce});
    const checkedA=await verifyCipherScope(proofA,pinA,alice.peer,alice.user,'dm',scope,nonce);
    const checkedB=await verifyCipherScope(proofB,pinB,bob.peer,bob.user,'dm',scope,nonce);
    assert.equal(checkedA.membership.scope,checkedB.membership.scope);
    assert.equal(checkedA.body.epoch,3);assert.equal(checkedB.body.epoch,3);
    await assert.rejects(verifyCipherScope(proofA,pinB,alice.peer,alice.user,'dm',scope,nonce));
    const envelope=await a.encrypt('dm',scope,randomUUID(),'Между разными точками');
    await b.receiveKey('dm',scope,alice.identity,take(bob.identity));
    assert.equal((await b.decrypt('dm',scope,alice.identity,envelope)).text,'Между разными точками');
    const response=await b.encrypt('dm',scope,randomUUID(),'Обратный ответ');
    await a.receiveKey('dm',scope,bob.identity,take(alice.identity));
    assert.equal((await a.decrypt('dm',scope,bob.identity,response)).text,'Обратный ответ');
    await second.rpc({operation:'available',value:false});
    await assert.rejects(b.encrypt('dm',scope,randomUUID(),'Не отправлять без кворума'));
    // A slow SDK operation may outlive the short authorization. Renewing must
    // preserve the exact membership, and reject a changed epoch before release.
    const clockNow=Date.now,cryptoNode=require('node:crypto'),entryPair=generateKeyPairSync('ed25519');
    const publicKey=entryPair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
    const nodeId=cryptoNode.createHash('sha256').update(Buffer.from('sfera-mesh-node-v1\0')).update(Buffer.from(publicKey,'hex')).digest('hex');
    const freshPin={...pinA,nodeId,publicKey};let clock=Math.floor(clockNow()/1000),changed=false;
    try {
      Date.now=()=>clock*1000;
      const provider=async({nonce})=>{const body=structuredClone(proofA.body);body.entry=nodeId;body.nonce=nonce;body.issued_at=clock;body.expires_at=clock+15;
        if(changed){body.device_versions[0].version++;body.epoch++;}
        return {body,signature:cryptoNode.sign(null,accountBytes(body),entryPair.privateKey).toString('hex')};};
      const sdk={publicIdentity:()=>alice.peer,encryptGroup:async()=>{clock+=20;return {message_id:'timing-check'};}};
      const slow=new AuthorizedCipher(sdk,freshPin,alice.user,provider,()=>{},async()=>true);
      assert.equal((await slow.encryptAuthorized('dm',scope,randomUUID(),'timing')).envelope.message_id,'timing-check');
      sdk.encryptGroup=async()=>{clock+=20;changed=true;return {message_id:'must-not-release'};};
      await assert.rejects(slow.encryptAuthorized('dm',scope,randomUUID(),'timing'),/changed_during_operation/);
    }finally{Date.now=clockNow;}
    console.log('Distributed scope passed: real SDK consensus-command signatures, frozen command bodies, distinct entry signatures, shared DM room/epoch, real WASM encryption in both directions, wrong-entry and unavailable-authority rejection. SDK relay is a test adapter; WAN delivery not tested.');
  } finally {
    if(alice)await alice.cipher.close();if(bob)await bob.cipher.close();
    await first.close();await second.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
