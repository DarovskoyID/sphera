"""Seven independent authorities derive DM scopes from the same public state.

Fixture consensus is supplied in memory; this does not test network delivery.
Every session and scope signature is real and each authority has its own SQL DB.
"""
import base64
import copy
from hashlib import sha256
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.test_cipher_authority import Directory
from sfera_mesh.distributed_sessions import DistributedApplicationSessions
from sfera_mesh.application_profiles import application_user_id
from sfera_mesh.application_dialogs import dialog_id,conversation_id
from sfera_mesh.application_cipher import namespace
from sfera_mesh.cipher_authority import CipherAuthority
from sfera_mesh.directory import user_id,ZERO
from sfera_mesh.devices import device_id,verify_event
from sfera_mesh.identity import node_id
from sfera_mesh.storage import canonical
from sfera_mesh.consensus_directory import ConsensusUnavailable


class DistributedScope(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.directory=Directory();self.people=[]
        state={'accounts':{},'devices':{},'application_profiles':{},'application_dialogs':{},'cipher_devices':{}}
        self.directory.current={'state':state}
        for index in range(2):
            root,device=Ed25519PrivateKey.generate(),Ed25519PrivateKey.generate()
            public=root.public_key().public_bytes_raw().hex();owner=user_id(bytes.fromhex(public))
            did=device_id(device.public_key().public_bytes_raw())
            body={'domain':'sfera-mesh-device-event-lab-v1','network':'lab','user_id':owner,'version':1,'previous':ZERO,
                  'operation':'enroll','device_id':did,'device_public':device.public_key().public_bytes_raw().hex()}
            event={'body':body,'owner_signature':root.sign(canonical(body)).hex(),'device_signature':device.sign(canonical(body)).hex()}
            self.directory.owners[owner]=(public,[event])
            state['accounts'][owner]={'record':{'body':{'public_key':public}}}
            state['devices'][owner]=[{'event':event}]
            body={'domain':'sfera-mesh-application-profile-v1','network':'lab','genesis':self.directory.pin,'owner':owner,
                  'control_epoch':0,'version':1,'previous':ZERO,'handle':'person'+str(index),'nickname_utf8':'Тест'.encode().hex()}
            record={'body':body,'signature':root.sign(canonical(body)).hex()}
            state['application_profiles'][owner]=[{'record':record,'digest':sha256(canonical(record)).hexdigest()}]
            body={'domain':'sfera-mesh-cipher-device-v1','network':'lab','genesis':self.directory.pin,'owner':owner,
                  'device':did,'device_public':device.public_key().public_bytes_raw().hex(),
                  **{field:base64.b64encode(Ed25519PrivateKey.generate().public_key().public_bytes_raw()).decode().rstrip('=')
                     for field in ('ed25519','curve25519')}}
            certificate={'body':body,'signature':device.sign(canonical(body)).hex()}
            state['cipher_devices'][owner+':'+did]={'certificate':certificate}
            self.people.append({'root':root,'device':device,'owner':owner,'did':did,'user':application_user_id('lab',owner)})
        members=sorted(person['owner'] for person in self.people)
        identity=dialog_id('lab',members);self.scope=conversation_id(identity)
        body={'domain':'sfera-mesh-application-dialog-v1','network':'lab','genesis':self.directory.pin,
              'creator':self.people[0]['owner'],'control_epoch':0,'members':members}
        record={'body':body,'signature':self.people[0]['root'].sign(canonical(body)).hex()}
        state['application_dialogs'][identity]={'record':record,'digest':sha256(canonical(record)).hexdigest()}
        self.dialog=identity;self.members=sorted(person['user'] for person in self.people)

    def entry(self,index):
        key=Ed25519PrivateKey.generate()
        backend=DistributedApplicationSessions(str(Path(self.temp.name)/(str(index)+'.sqlite')),self.directory,
                    node_id(key.public_key().public_bytes_raw()),entry_key=key)
        self.addCleanup(backend.close);backend.require_consensus_cipher_pins=True
        person=self.people[index%2]
        challenge=backend.login_challenge(person['owner'],person['did'],now=100)
        claim=backend.complete(person['user'],challenge['login_jti'],challenge['challenge'],None,
                  person['device'].sign(canonical(challenge)).hex(),700,now=101,purpose='login')
        return backend,CipherAuthority(backend),person,claim

    def attest(self,entry):
        backend,authority,person,claim=entry
        proof=authority.attest(person['user'],claim,'dm',self.scope,self.members,'f'*64,now=103)
        backend.entry_key.public_key().verify(bytes.fromhex(proof['signature']),canonical(proof['body']))
        return proof

    def test_seven_entries_shared_namespace_and_no_local_peer_bindings(self):
        entries=[self.entry(index) for index in range(7)]
        proofs=[self.attest(entry) for entry in entries]
        self.assertEqual(len({proof['body']['entry'] for proof in proofs}),7)
        for field in ('roster','epoch','dialog','device_versions','members','certificates'):
            self.assertTrue(all(proof['body'][field]==proofs[0]['body'][field] for proof in proofs))
        self.assertEqual(proofs[0]['body']['epoch'],3)
        self.assertEqual(namespace('lab',self.directory.pin,self.dialog),namespace('lab',self.directory.pin,proofs[-1]['body']['dialog']))
        for backend,_,_,_ in entries:
            self.assertEqual(backend.db.execute('SELECT count(*) FROM app_identities').fetchone()[0],1)
        self.directory.available=False
        with self.assertRaises(ConsensusUnavailable):self.attest(entries[0])

    def test_missing_pin_acl_change_and_local_rollback_fail_closed(self):
        entry=self.entry(0);proof=self.attest(entry)
        state=self.directory.current['state'];saved=copy.deepcopy(state['cipher_devices'])
        state['cipher_devices'].clear()
        with self.assertRaisesRegex(ValueError,'pin_pending'):self.attest(entry)
        state['cipher_devices']=saved
        with self.assertRaisesRegex(ValueError,'acl_mismatch'):
            entry[1].attest(entry[2]['user'],entry[3],'dm',self.scope,self.members,'f'*64,now=103,revalidate=lambda:[])
        with entry[0].db:
            entry[0].db.execute('UPDATE cipher_scopes SET epoch=?',(proof['body']['epoch']+1,))
        with self.assertRaisesRegex(ValueError,'rollback_or_fork'):self.attest(entry)

    def test_late_entry_uses_global_device_epoch_and_history_rollback_is_rejected(self):
        first=self.entry(0);original=self.attest(first)
        person=self.people[1];replacement=Ed25519PrivateKey.generate()
        public=replacement.public_key().public_bytes_raw().hex();did=device_id(bytes.fromhex(public))
        owner=person['owner'];events=self.directory.owners[owner][1]
        old=copy.deepcopy(events)
        for operation in ('enroll','revoke'):
            body={'domain':'sfera-mesh-device-event-lab-v1','network':'lab','user_id':owner,
                  'version':len(events)+1,'previous':verify_event(events[-1],'lab',self.directory.owners[owner][0])[1],
                  'operation':operation,'device_id':did,'device_public':public}
            events.append({'body':body,'owner_signature':person['root'].sign(canonical(body)).hex(),
                           'device_signature':replacement.sign(canonical(body)).hex() if operation=='enroll' else ''})
        self.directory.current['state']['devices'][owner]=[{'event':event} for event in events]
        updated=self.attest(first);late=self.attest(self.entry(1))
        self.assertEqual(updated['body']['epoch'],original['body']['epoch']+2)
        self.assertEqual(updated['body']['roster'],original['body']['roster'])
        self.assertEqual(updated['body']['epoch'],late['body']['epoch'])
        self.directory.owners[owner]=(self.directory.owners[owner][0],old)
        self.directory.current['state']['devices'][owner]=[{'event':event} for event in old]
        with self.assertRaisesRegex(ValueError,'rollback_or_fork'):self.attest(first)

    def test_snapshot_advancing_during_final_refresh_cannot_sign_stale_roster(self):
        entry=self.entry(0);backend,authority,person,claim=entry
        original=self.directory.anchor;calls=0
        def advance():
            nonlocal calls
            calls+=1
            # require() refreshes twice; the final attest refresh observes a
            # new snapshot where a peer's SDK pin is unavailable.
            if calls==3:self.directory.current['state']['cipher_devices'].clear()
            return original()
        self.directory.anchor=advance
        with self.assertRaisesRegex(ValueError,'pin_pending'):
            authority.attest(person['user'],claim,'dm',self.scope,self.members,'f'*64,now=103)
        self.assertEqual(backend.db.execute('SELECT count(*) FROM cipher_scopes').fetchone()[0],0)


if __name__=='__main__':unittest.main()
