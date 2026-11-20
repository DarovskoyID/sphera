"""Two independent entry keys/replay stores; no broker or common SQL database."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_distribution.signaling import ApplicationSignalRelay
from sfera_mesh.application_profiles import application_user_id
from sfera_mesh.identity import envelope,node_id


class Relay(unittest.TestCase):
    def test_signed_cross_entry_route_without_broker(self):
        fixture=json.loads(Path('mesh-consensus/testdata/application-dialog-v1.json').read_text())
        packet=json.loads(Path('output/mesh-application-20261119/signal-client-fixture.json').read_text())
        keys=[Ed25519PrivateKey.generate() for _ in range(2)];ids=[node_id(k.public_key().public_bytes_raw()) for k in keys]
        peers={identity:{'public_key':key.public_key().public_bytes_raw(),'origin':'https://entry-'+str(i)+'.example'} for i,(identity,key) in enumerate(zip(ids,keys))}
        directories=[SimpleNamespace(lock=threading.RLock(),network=fixture['network'],pin=fixture['genesis'],current={'state':copy.deepcopy(fixture['state'])},anchor=lambda:None) for _ in keys]
        calls=[];routes=[];backends=[]
        user=application_user_id(fixture['network'],fixture['creator'])
        claim={'owner':fixture['creator'],'device':fixture['device'],'entry':ids[0],'genesis':fixture['genesis']}
        def authorize(actor,value):
            if actor!=user or value!=claim:raise ValueError('inactive application session')
        def receive_local(checked,proof):calls.append((checked,proof));return True
        def post(origin,message):
            routes.append(origin)
            index=[p['origin'] for p in peers.values()].index(origin)
            return backends[index].receive(message,now=101)
        with tempfile.TemporaryDirectory() as tmp:
            try:
                for index,key in enumerate(keys):
                    backend=ApplicationSignalRelay(key,directories[index],str(Path(tmp)/(str(index)+'-nodes.sqlite')),str(Path(tmp)/(str(index)+'-signals.sqlite')),
                        authorize=authorize,local=(lambda *_:False) if index==0 else receive_local,peers=lambda _:peers,post=post)
                    backends.append(backend)
                result=backends[0].forward(packet,user,claim,now=101)
                self.assertEqual(result,{'routed':True});self.assertEqual(len(calls),1);self.assertEqual(routes,['https://entry-1.example'])
                self.assertEqual(calls[0][0]['signal']['sdp']['sdp'],'v=0\r\ns=synthetic-local-test\r\n')
                with self.assertRaises(ValueError):backends[0].forward(packet,user,claim,now=101)
                with self.assertRaises(ValueError):backends[0].forward(packet,'00000000-0000-0000-0000-000000000000',claim,now=101)
                unknown=Ed25519PrivateKey.generate()
                with self.assertRaises(ValueError):backends[1].receive(envelope(unknown,fixture['network'],ids[1],'application-signal-v1',{'packet':packet},now=101),now=101)
                directories[1].current['state']['devices'][fixture['creator']][-1]['event']['body']['operation']='revoke'
                with self.assertRaises(ValueError):backends[1].receive(envelope(keys[0],fixture['network'],ids[1],'application-signal-v1',{'packet':packet},now=101),now=101)
                self.assertEqual(len(calls),1,'rejected/revoked signal reached recipient')
            finally:
                for backend in backends:backend.close()


if __name__=='__main__':unittest.main()
