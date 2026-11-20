"""Real device signatures; persistent replay checks and no SDP/ICE persistence."""
import copy
from pathlib import Path
import json
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'django-server/sfera_server'))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sfera_mesh.application_signals import verify_signal,SignalReplayJournal
from sfera_mesh.application_dialogs import verify_record,validate_dialogs
from sfera_mesh.application_catalog import ApplicationCatalog
from sfera_mesh.storage import canonical


class Signals(unittest.TestCase):
    def setUp(self):
        self.fixture=json.loads(Path('mesh-consensus/testdata/application-dialog-v1.json').read_text())
        self.packet=json.loads(Path('output/mesh-application-20261119/signal-client-fixture.json').read_text())
        self.directory=SimpleNamespace(network=self.fixture['network'],pin=self.fixture['genesis'],
            lock=threading.RLock(),current={'state':copy.deepcopy(self.fixture['state'])},anchor=lambda:None)

    def test_browser_signature_and_replay_survive_restart(self):
        checked=verify_signal(self.packet,self.directory,now=101)
        self.assertEqual(checked['signal']['type'],'offer')
        with tempfile.TemporaryDirectory() as tmp:
            path=str(Path(tmp)/'replays.sqlite');journal=SignalReplayJournal(path)
            try:
                journal.accept(self.packet,self.directory,now=101)
                with self.assertRaises(ValueError):journal.accept(self.packet,self.directory,now=101)
                stored=str(journal.db.execute('SELECT * FROM application_signals').fetchall())
                self.assertNotIn('synthetic-local-test',stored);self.assertNotIn('v=0',stored)
            finally:journal.close()
            journal=SignalReplayJournal(path)
            try:
                with self.assertRaises(ValueError):journal.accept(self.packet,self.directory,now=102)
            finally:journal.close()

    def test_device_creates_dialog_without_owner_root(self):
        record=json.loads(Path('output/mesh-application-20261119/device-dialog-client-fixture.json').read_text())
        self.assertEqual(record,self.fixture['device_dialog'])
        identity,digest=verify_record(record,self.directory.current['state'],self.directory.network,self.directory.pin)
        self.assertEqual(identity,self.fixture['dialog_identity'])
        self.assertEqual(digest,self.fixture['device_dialog_digest'])
        self.directory.current['state']['application_dialogs']={};sent=[]
        catalog=ApplicationCatalog(self.directory,sent.append)
        self.assertEqual(catalog.dialog(record)['state'],'pending');self.assertEqual(sent,[record])
        self.directory.current['state']['application_dialogs'][identity]={'record':record,'digest':digest}
        self.assertEqual(catalog.dialog(record)['state'],'confirmed');self.assertEqual(len(sent),1)
        validate_dialogs(self.directory.current['state'],self.directory.network,self.directory.pin)

    def test_forgery_expiry_revocation_and_wrong_recipient(self):
        forged=copy.deepcopy(self.packet);forged['body']['recipient']=self.fixture['creator']
        with self.assertRaises(ValueError):verify_signal(forged,self.directory,now=101)
        forged=copy.deepcopy(self.packet);forged['signature']='0'*128
        with self.assertRaises(ValueError):verify_signal(forged,self.directory,now=101)
        with self.assertRaises(ValueError):verify_signal(self.packet,self.directory,now=130)
        self.directory.current['state']['devices'][self.fixture['creator']][-1]['event']['body']['operation']='revoke'
        with self.assertRaises(ValueError):verify_signal(self.packet,self.directory,now=101)

    def test_device_cannot_spoof_other_application_user(self):
        packet=copy.deepcopy(self.packet);key=Ed25519PrivateKey.from_private_bytes(bytes([9])*32)
        signal=json.loads(bytes.fromhex(packet['body']['signal_utf8']))
        signal['from']=signal['to'];packet['body']['signal_utf8']=canonical(signal).hex()
        packet['signature']=key.sign(canonical(packet['body'])).hex()
        with self.assertRaises(ValueError):verify_signal(packet,self.directory,now=101)
        packet=copy.deepcopy(self.packet);signal['type']=[];packet['body']['signal_utf8']=canonical(signal).hex();packet['signature']=key.sign(canonical(packet['body'])).hex()
        with self.assertRaises(ValueError):verify_signal(packet,self.directory,now=101)
        self.directory.current['state']['application_dialogs']={}
        with self.assertRaises(ValueError):verify_signal(self.packet,self.directory,now=101)


if __name__=='__main__':unittest.main()
