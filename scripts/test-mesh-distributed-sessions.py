"""Independent entry session stores, one confirmed account/device identity."""
from hashlib import sha256
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.test_application_sessions import Directory
from sfera_mesh.distributed_sessions import DistributedApplicationSessions
from sfera_mesh.application_sessions import ApplicationSessions
from sfera_mesh.application_profiles import application_user_id
from sfera_mesh.devices import device_id,verify_event
from sfera_mesh.directory import user_id,ZERO
from sfera_mesh.storage import canonical
from sfera_mesh.consensus_directory import ConsensusUnavailable


class FreshDirectory(Directory):
    def anchor(self):
        if not self.available:raise ConsensusUnavailable('offline')
        return {'expires_at':130}


class DistributedSessions(unittest.TestCase):
    def test_seven_entries_proof_replay_revocation_and_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            owner,device=Ed25519PrivateKey.generate(),Ed25519PrivateKey.generate()
            directory=FreshDirectory(owner);oid=user_id(bytes.fromhex(directory.owner));did=device_id(device.public_key().public_bytes_raw())
            public=device.public_key().public_bytes_raw().hex()
            b={'domain':'sfera-mesh-device-event-lab-v1','network':'lab','user_id':oid,'version':1,'previous':ZERO,
                'operation':'enroll','device_id':did,'device_public':public}
            directory.events.append({'body':b,'owner_signature':owner.sign(canonical(b)).hex(),'device_signature':device.sign(canonical(b)).hex()})
            b={'domain':'sfera-mesh-application-profile-v1','network':'lab','genesis':directory.pin,'owner':oid,
                'control_epoch':0,'version':1,'previous':ZERO,'handle':'alice','nickname_utf8':'Алиса'.encode().hex()}
            r={'body':b,'signature':owner.sign(canonical(b)).hex()}
            directory.current={'state':{'accounts':{oid:{'record':{'body':{'public_key':directory.owner}}}},
                'application_profiles':{oid:[{'record':r,'digest':sha256(canonical(r)).hexdigest()}]}}}
            user=application_user_id('lab',oid);backends=[];claims=[]
            try:
                for index in range(7):
                    backend=DistributedApplicationSessions(str(Path(tmp)/(str(index)+'.sqlite')),directory,f'{index+1:064x}');backends.append(backend)
                    challenge=backend.login_challenge(oid,did,now=100)
                    self.assertEqual(challenge['application_user'],user)
                    with self.assertRaises(ValueError):backend.complete(user,challenge['login_jti'],challenge['challenge'],None,'0'*128,700,now=101,purpose='login')
                    claim=backend.complete(user,challenge['login_jti'],challenge['challenge'],None,device.sign(canonical(challenge)).hex(),700,now=101,purpose='login')
                    backend.require(user,claim,now=102);claims.append(claim)
                    with self.assertRaises(ValueError):backend.complete(user,challenge['login_jti'],challenge['challenge'],None,device.sign(canonical(challenge)).hex(),700,now=101,purpose='login')
                with self.assertRaises(ValueError):backends[1].require(user,claims[0],now=102)
                backends[0].close()
                with self.assertRaises(ValueError):ApplicationSessions(str(Path(tmp)/'0.sqlite'),directory,f'{1:064x}')
                backends[0]=DistributedApplicationSessions(str(Path(tmp)/'0.sqlite'),directory,f'{1:064x}')
                backends[0].require(user,claims[0],now=102)
                with self.assertRaises(ValueError):backends[0].challenge('00000000-0000-0000-0000-000000000000','jti',oid,did,now=100)
                directory.available=False
                with self.assertRaises(ConsensusUnavailable):backends[2].login_challenge(oid,did,now=100)
                directory.available=True
                previous=verify_event(directory.events[-1],'lab',directory.owner)[1]
                b={'domain':'sfera-mesh-device-event-lab-v1','network':'lab','user_id':oid,'version':2,'previous':previous,
                    'operation':'revoke','device_id':did,'device_public':public}
                directory.events.append({'body':b,'owner_signature':owner.sign(canonical(b)).hex(),'device_signature':''})
                for backend,claim in zip(backends,claims):
                    with self.assertRaises(ValueError):backend.require(user,claim,now=102)
            finally:
                for backend in backends:backend.close()


if __name__=='__main__':unittest.main()
