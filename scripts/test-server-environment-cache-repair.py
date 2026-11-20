import os
from pathlib import Path
import tempfile
import time
import unittest
from server_update import environment_fingerprint
from server_environment_cache_repair import quarantine_bytecode


class CacheRepair(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'environment';self.root.mkdir()
        (self.root/'module.py').write_bytes(b'admitted source')
        cache=self.root/'lib/__pycache__';cache.mkdir(parents=True)
        (cache/'original.pyc').write_bytes(b'admitted original cache')
        self.accepted=int(time.time())-10
        os.utime(cache/'original.pyc',(self.accepted-10,self.accepted-10))
        self.expected=environment_fingerprint(self.root)
        self.new=cache/'new.pyc';self.new.write_bytes(b'new generated cache')

    def test_exact_old_fingerprint_restored_and_cache_retained(self):
        quarantine=self.base/'quarantine'
        files=quarantine_bytecode(self.root,self.expected,self.accepted,quarantine)
        self.assertEqual(files,['lib/__pycache__/new.pyc'])
        self.assertEqual(environment_fingerprint(self.root),self.expected)
        self.assertEqual((quarantine/files[0]).read_bytes(),b'new generated cache')
        self.assertTrue((self.root/'lib/__pycache__/original.pyc').exists())
        self.assertEqual(quarantine_bytecode(self.root,self.expected,self.accepted,self.base/'unused'),[])

    def test_other_changed_files_rejected_without_moving_anything(self):
        (self.root/'module.py').write_bytes(b'changed source')
        with self.assertRaisesRegex(ValueError,'not_restorable'):
            quarantine_bytecode(self.root,self.expected,self.accepted,self.base/'quarantine')
        self.assertTrue(self.new.exists());self.assertFalse((self.base/'quarantine').exists())

    def test_approved_cache_not_removable_as_a_late_file(self):
        original=self.root/'lib/__pycache__/original.pyc';original.write_bytes(b'changed approved cache')
        with self.assertRaisesRegex(ValueError,'not_restorable'):
            quarantine_bytecode(self.root,self.expected,self.accepted,self.base/'quarantine')
        self.assertTrue(original.exists());self.assertTrue(self.new.exists())


if __name__=='__main__':unittest.main()
