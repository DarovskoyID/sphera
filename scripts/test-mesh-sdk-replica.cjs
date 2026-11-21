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
export * from './src/core/mesh/pairwiseCipher';export * from './src/core/mesh/dmCipherCoordinator';export * from './src/core/mesh/cipherRelayClient';export * from './src/core/mesh/cipherKeyInbox';
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
const { DmCipherCoordinator,CipherRelayClient,receivePendingDmKeys, PairwiseCipher, AuthorizedCipher, DmCipherMessages, parseDmCipherMessage, CipherArchive, RecoveryClient, assembleArchiveDeletion, signCipherCertificate, verifyCipherCertificate,
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
    rpc: body => new Promise((resolve, reject) => { pending.push({ resolve, reject:e=>reject(new Error(body.operation+": "+e.message)) }); child.stdin.write(JSON.stringify(body) + '\n'); }),
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
  let channel;const cipher = await PairwiseCipher.open(identity, request=>channel.relay(request), storage);
  const peer = cipher.publicIdentity();
  const certificate = await signCipherCertificate(peer, device.public, device.root);
  const event = await signDeviceEvent(owner.root, owner.public, { domain: 'sfera-mesh-device-event-lab-v1', network: 'lab',
    user_id: identity.owner, version: 1, previous: '0'.repeat(64), operation: 'enroll', device_id: identity.device, device_public: device.public }, device.root);

  return { owner, device, user, identity, storage, cipher, peer, certificate, event,setChannel(value){channel=value},
    setup: { user, owner_public: owner.public, event, certificate, session: randomBytes(32).toString('hex') } };
}


(async()=>{const server=fixture();let alice,bob;const coordinators=[];
 try {alice=await person(true);bob=await person(true);
  for(const [i,p] of [alice,bob].entries()){p.user=await applicationUserId('lab',p.identity.owner);p.setup.user=p.user;p.setup.profile=await initialApplicationProfile(p.owner.root,p.owner.public,'lab','a'.repeat(64),'replica'+i,'Replica test');}
  const dialog=await initialApplicationDialog(alice.owner.root,alice.owner.public,'lab','a'.repeat(64),bob.identity.owner),scope=applicationConversationId(await applicationDialogId('lab',dialog.body.members));
  const pins=await server.rpc({operation:'setup',distributed:true,replicas:true,users:[alice.setup,bob.setup],dialog});assert.equal(pins.length,7);
  for(const [entry,p] of [alice,bob].entries()) {
   await p.cipher.close();
   const coordinator=await DmCipherCoordinator.open(p.identity,pins[entry],p.user,p.storage.passphrase,{distributed:true,guard:()=>true,token:()=> 'fixture-session',review:async()=>true,
    transport:async(url,init)=>{
      const body=init.body?JSON.parse(init.body):{};let request;
      if(url.endsWith('/entry/'))request={operation:'replica_entry',entry,...body};
      else if(url.endsWith('/catalog/'))request={operation:'replica_catalog'};
      else if(url.endsWith('/device/'))request={operation:'replica_publish',entry,user:p.user,...body};
      else if(url.endsWith('/keys/'))request={operation:'replica_keys',...body};
      else if(url.endsWith('/scope/'))request={operation:'replica_scope',entry,user:p.user,...body};
      else request={operation:'replica_request',entry,user:p.user,...body};
      return Response.json(await server.rpc(request));
    }});
   coordinators.push(coordinator);await coordinator.registerDevice(p.certificate);await coordinator.close();
   p.cipher=await PairwiseCipher.open(p.identity,request=>p.channel.relay(request),p.storage);
  }
  for(const [entry,p] of [alice,bob].entries()){
   const post=(route,body)=>{if(body.record?.body?.request?.type===6)p.messageRecord=body.record;return server.rpc(route.endsWith('/scope/')?{operation:'replica_scope',entry,user:p.user,...body}:route==='/api/distribution/keys/'?{operation:'replica_keys',record:body.record}:{operation:'replica_request',entry,user:p.user,...body});};
   p.channel=new CipherRelayClient({pin:pins[entry],user:p.user,scope,identity:()=>p.cipher.publicIdentity(),post,review:async()=>true,guard:()=>{},signKey:body=>p.cipher.signApplicationKeyCommand(body),signPayload:body=>p.cipher.signApplicationPayload(body)});p.setChannel(p.channel);
   p.policy=new AuthorizedCipher(p.cipher,pins[entry],p.user,b=>post('/scope/',b),()=>{},async()=>true);
   p.dm=new DmCipherMessages(p.policy,p.identity,p.user);
  }
  await alice.cipher.publishKeys();await bob.cipher.publishKeys();
  const wire=await alice.dm.seal(scope,randomUUID(),{text:'Distributed encrypted message',replyTo:null});
  assert(!JSON.stringify(wire).includes('Distributed encrypted message'));
  await alice.channel.publishMessage(wire,Date.now());
  assert.equal(await receivePendingDmKeys(bob.policy,bob.channel,scope),1);
  assert.equal((await bob.dm.open(scope,wire)).text,'Distributed encrypted message');
  assert.equal((await bob.channel.pending()).length,0);
  const answer=await bob.dm.seal(scope,randomUUID(),{text:'Reply through another replica',replyTo:null});await bob.channel.publishMessage(answer,Date.now());
  await receivePendingDmKeys(alice.policy,alice.channel,scope);assert.equal((await alice.dm.open(scope,answer)).text,'Reply through another replica');
  require('node:fs').mkdirSync('output/sdk-replica-20261120',{recursive:true});require('node:fs').writeFileSync('output/sdk-replica-20261120/message-fixture.json',JSON.stringify({...await server.rpc({operation:'replica_fixture'}),record:alice.messageRecord}));
  console.log('PASS: real WASM SDK, consensus key/fallback uploads and claims, seven independent replica stores, signed encrypted message replication, key ACKs and decryption in both directions. Consensus and network transport are fixtures; WAN and Django projections are not tested here.');
 }finally{for(const c of coordinators)await c.close();if(alice)await alice.cipher.close();if(bob)await bob.cipher.close();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
