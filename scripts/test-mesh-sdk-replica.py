"""Seven independent SQLite replicas, real SDK/node signatures; fixture transport."""
import base64,copy,importlib.util,json,sys,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.storage import canonical
from sfera_mesh.application_cipher import scope_for
from sfera_distribution.sdk_replica import SdkReplica

class Replicas(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('scope_fixture',Path(__file__).with_name('test-mesh-distributed-cipher-scope.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
  self.fixture=mod.DistributedScope();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
  self.clock=patch('time.time',return_value=103);self.clock.start();self.addCleanup(self.clock.stop)
  self.keys=[Ed25519PrivateKey.generate() for _ in range(2)]
  for i,p in enumerate(self.fixture.people):
   cert=self.fixture.directory.current['state']['cipher_devices'][p['owner']+':'+p['did']]['certificate'];cert['body']['ed25519']=base64.b64encode(self.keys[i].public_key().public_bytes_raw()).decode().rstrip('=');cert['signature']=p['device'].sign(canonical(cert['body'])).hex()
  self.entries=[self.fixture.entry(i) for i in range(7)];self.offline=set();self.replicas={}
  roster={b.entry:{'public_key':b.entry_key.public_key().public_bytes_raw(),'origin':b.entry} for b,*_ in self.entries}
  def transport(origin,message):
   if origin in self.offline:raise OSError('fixture_offline')
   return self.replicas[origin].receive(copy.deepcopy(message))
  for i,(b,a,*_) in enumerate(self.entries):
   replica=SdkReplica(a,str(Path(self.fixture.temp.name)/('replay-'+str(i)+'.sqlite')),peers=lambda d:roster,transport=transport);self.replicas[b.entry]=replica;self.addCleanup(replica.close)
 def signed(self,actor,kind,body,request):
  p=self.fixture.people[actor];f=self.fixture;shared=scope_for(f.directory.current['state'],'lab',f.directory.pin,f.scope)
  b={'domain':'sfera-mesh-sdk-relay-v1','network':'lab','genesis':f.directory.pin,'owner':p['owner'],'device':p['did'],'source':'dm','scope':f.scope,'roster':shared['roster'],'epoch':shared['epoch'],'request':{'id':request,'type':kind,'body':json.dumps(body)},'issued_at':103,'expires_at':163}
  return {'body':b,'signature':base64.b64encode(self.keys[actor].sign(canonical(b))).decode().rstrip('=')}
 def request(self,index,record):
  b,a,p,claim=self.entries[index];return self.replicas[b.entry].request(record,p['user'],claim)
 def test_quorum_mail_tombstones_and_delayed_replica(self):
  own,target=[self.fixture.directory.current['state']['cipher_devices'][p['owner']+':'+p['did']]['certificate']['body'] for p in self.fixture.people]
  user='@'+target['owner']+':'+target['genesis']+'.sphere'
  mail=self.signed(0,3,{'messages':{user:{target['device']:{'algorithm':'m.olm.v1.curve25519-aes-sha2','sender_key':own['curve25519'],'ciphertext':{target['curve25519']:{'type':0,'body':'YWJj'}}}}}},'mail-1')
  self.offline={self.entries[i][0].entry for i in (5,6)}
  self.assertEqual(self.request(0,mail),{})
  read=self.signed(1,4,{},'read-1');messages=self.request(3,read)['messages'];self.assertEqual(len(messages),1)
  self.assertEqual(self.request(0,mail),{})
  self.assertEqual(self.request(1,read)['messages'],messages)
  ack=self.signed(1,5,{'ids':[messages[0]['id']]},'ack-1');self.request(1,ack)
  self.offline.clear()
  # A lagging replica first receives old mail, then reconciles permanent ACKs.
  self.replicas[self.entries[5][0].entry].apply(mail)
  self.assertEqual(self.request(5,self.signed(1,4,{},'read-after-ack'))['messages'],[])
  self.assertEqual(self.request(3,self.signed(1,4,{},'read-final'))['messages'],[])
 def test_device_bootstrap_does_not_require_a_dialog(self):
  f=self.fixture;person=f.people[0];cert=f.directory.current['state']['cipher_devices'][person['owner']+':'+person['did']]['certificate']['body']
  doc={'user_id':'@'+person['owner']+':'+f.directory.pin+'.sphere','device_id':person['did'],'algorithms':['m.olm.v1.curve25519-aes-sha2','m.megolm.v1.aes-sha2'],'keys':{'ed25519:'+person['did']:cert['ed25519'],'curve25519:'+person['did']:cert['curve25519']}}
  doc['signatures']={doc['user_id']:{'ed25519:'+person['did']:base64.b64encode(self.keys[0].sign(canonical(doc))).decode().rstrip('=')}}
  signed=self.signed(0,0,{'device_keys':doc},'bootstrap')
  body=signed['body'];body.update(source='device',scope=person['user'],epoch=1)
  from hashlib import sha256
  body['roster']=sha256(canonical(['sfera-mesh-sdk-device-scope-v1','lab',f.directory.pin,person['owner'],person['did'],1])).hexdigest()
  signed['signature']=base64.b64encode(self.keys[0].sign(canonical(body))).decode().rstrip('=')
  f.directory.current['state']['application_dialogs'].clear()
  self.assertEqual(self.request(0,signed),{'one_time_key_counts':{'signed_curve25519':0}})
  self.assertGreaterEqual(sum(b.db.execute('SELECT COUNT(*) FROM cipher_relay_devices').fetchone()[0] for b,*_ in self.entries),5)

 def test_application_discovery_does_not_count_validator_aliases(self):
  raw={b.entry:{'public_key':b.entry_key.public_key().public_bytes_raw(),'origin':'https://entry-'+str(i)+'.invalid'} for i,(b,*_) in enumerate(self.entries)}
  from sfera_mesh.identity import node_id
  for i in range(4):
   key=Ed25519PrivateKey.generate();public=key.public_key().public_bytes_raw();raw[node_id(public)]={'public_key':public,'origin':'https://entry-'+str(i)+'.invalid'}
  replica=self.replicas[self.entries[0][0].entry]
  calls=[]
  def probe(origin,nonce):
   calls.append(origin);index=int(origin.split('entry-')[1].split('.')[0]);return self.entries[index][0].entry_proof(nonce,now=103)
  replica.probe=probe
  chosen=replica.application_bindings(raw)
  self.assertEqual(len(raw),11);self.assertEqual(set(chosen),{b.entry for b,*_ in self.entries});self.assertEqual(len(calls),7)
  replica.probe=lambda *_:(_ for _ in ()).throw(OSError('offline'))
  self.assertEqual(replica.application_bindings(raw),chosen,'offline entries must retain their quorum membership')

 def test_no_quorum_forgery_claim_or_substitution(self):
  read=self.signed(0,4,{},'read');bad=copy.deepcopy(read);bad['body']['owner']=self.fixture.people[1]['owner']
  with self.assertRaises(ValueError):self.request(0,bad)
  with self.assertRaisesRegex(ValueError,'session_actor'):self.request(1,read)
  claim=self.signed(0,2,{'one_time_keys':{}},'claim')
  with self.assertRaisesRegex(ValueError,'request_schema'):self.request(0,claim)
  self.offline={b.entry for b,*_ in self.entries[1:]}
  with self.assertRaisesRegex(ValueError,'quorum_unavailable'):self.request(0,read)

if __name__=='__main__':unittest.main()
