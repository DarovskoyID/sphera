const assert=require('node:assert/strict');
const {webcrypto,generateKeyPairSync,createHash,sign}=require('node:crypto');
const esbuild=require('esbuild'),Module=require('node:module'),path=require('node:path'),fs=require('node:fs');
globalThis.crypto=webcrypto;
const built=esbuild.buildSync({stdin:{contents:"export * from './src/core/mesh/applicationRegistration'; export * from './src/core/mesh/applicationAuth';",resolveDir:process.cwd()},bundle:true,packages:'external',platform:'node',format:'cjs',target:'es2022',write:false});
const loaded=new Module(path.resolve('output/registration-test.cjs'),module);loaded.filename=path.resolve('output/registration-test.cjs');loaded.paths=module.paths;loaded._compile(built.outputFiles[0].text,loaded.filename);
const {prepareApplicationRegistration,publishApplicationRegistration,answerApplicationChallenge,accessDistributedApplication}=loaded.exports;
const locks=new Set();Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name,options,callback)=>{
  if(locks.has(name))return callback(null);locks.add(name);try{return await callback({name});}finally{locks.delete(name);}
}}}});
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const encoded=value=>Buffer.from(JSON.stringify(sorted(value)));
(async()=>{
  const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
  const nodeId=createHash('sha256').update(Buffer.from('sfera-mesh-node-v1\0')).update(Buffer.from(publicKey,'hex')).digest('hex');
  const pin={network:'registration-lab',nodeId,publicKey,url:'https://fixture.sphere.invalid',label:'Fixture',id:'fixture'};
  const prepared=await prepareApplicationRegistration(pin,'a'.repeat(64),'alice','Алиса','local-password-12345');
  assert.notEqual(prepared.keys.ownerPublic,prepared.keys.devicePublic);
  assert(!JSON.stringify(prepared.bundle).includes('local-password'));
  assert(!JSON.stringify(prepared.bundle).includes('wrappedRoot'));
  const before=JSON.stringify(prepared);
  assert.deepEqual(await publishApplicationRegistration(prepared,async()=>({state:'pending',stage:'account',owner:prepared.bundle.account.body.user_id})),{state:'pending'});
  await assert.rejects(publishApplicationRegistration(prepared,async()=>({state:'confirmed',owner:prepared.bundle.account.body.user_id,device:'f'.repeat(64),application_user:prepared.keys.applicationUser})),/response/);
  assert.equal(JSON.stringify(prepared),before);
  const now=Math.floor(Date.now()/1000),challenge={domain:'sfera-mesh-application-login-v1',network:pin.network,genesis:'a'.repeat(64),entry:nodeId,
    owner:prepared.bundle.account.body.user_id,device:prepared.bundle.device.body.device_id,device_public:prepared.keys.devicePublic,
    application_user:prepared.keys.applicationUser,challenge:'b'.repeat(64),history_hash:'c'.repeat(64),history_version:1,login_jti:'fixture',issued_at:now,expires_at:now+60};
  const proof=await answerApplicationChallenge(prepared.keys,'local-password-12345',challenge,'login');
  assert.equal(proof.owner_signature,'');assert.equal(proof.device_signature.length,128);
  await assert.rejects(answerApplicationChallenge(prepared.keys,'wrong-password',challenge,'login'));
  const saved=new Map(),requests=[];let fail=true;let observedOwner,issuedChallenge;
  const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
  const post=async(path,body)=>{
    requests.push({path,body});
    assert(!JSON.stringify(body).includes('local-password'));
    if(path.endsWith('/entry/')) {
      const now=Math.floor(Date.now()/1000),probe={domain:'sfera-mesh-application-entry-v1',network:pin.network,entry:nodeId,
        genesis:'a'.repeat(64),nonce:body.nonce,issued_at:now,expires_at:now+15};
      return {body:probe,signature:sign(null,encoded(probe),pair.privateKey).toString('hex')};
    }
    const local=JSON.parse([...saved.values()][0]);assert(local.keys.ownerVault.wrappedRoot);
    if(path.endsWith('/registration/')) {
      assert.equal(saved.size,1,'credential must be durable before publishing');
      if(!observedOwner)observedOwner=body.account.body.user_id;
      assert.equal(body.account.body.user_id,observedOwner,'retry generated another account');
      if(fail){fail=false;throw new Error('injected_transport_failure');}
      return {state:'confirmed',owner:body.account.body.user_id,device:body.device.body.device_id,application_user:local.keys.applicationUser};
    }
    if(path.endsWith('/challenge/')) {
      const now=Math.floor(Date.now()/1000);issuedChallenge={...challenge,owner:body.owner,device:body.device,device_public:local.keys.devicePublic,
        application_user:local.keys.applicationUser,issued_at:now,expires_at:now+60};return issuedChallenge;
    }
    assert(path.endsWith('/login/'));
    const key=await crypto.subtle.importKey('raw',Buffer.from(local.keys.devicePublic,'hex'),'Ed25519',false,['verify']);
    assert(await crypto.subtle.verify('Ed25519',key,Buffer.from(body.device_signature,'hex'),encoded(issuedChallenge)));
    return {access:'test-adapter-token',mesh_session:{id:'test-adapter'}};
  };
  const options={pin,password:'local-password-12345',handle:'resume_test',nickname:'Повтор',register:true,storage,post,guard:()=>{},wait:async()=>{}};
  await assert.rejects(accessDistributedApplication(options),/injected_transport_failure/);
  assert.equal(await accessDistributedApplication(options),'test-adapter-token');
  assert.equal(saved.size,1);assert.equal(locks.size,0);
  fs.mkdirSync('output/mesh-application-20261119',{recursive:true});
  // Public documents only. No vaults, passwords or private fixture seeds.
  fs.writeFileSync('output/mesh-application-20261119/registration-public-fixture.json',JSON.stringify({network:pin.network,genesis:'a'.repeat(64),bundle:prepared.bundle,application_user:prepared.keys.applicationUser}));
  console.log('Registration client: local encrypted credentials before publish, exact identity after injected disconnect, reviewed entry signatures, public-only bundle and real device login signature passed. HTTP callbacks are test adapters.');
})().catch(error=>{console.error(error);process.exitCode=1;});
