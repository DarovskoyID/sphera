from pathlib import Path
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
import unittest

from .refresh_lock import RefreshLock


class RefreshLockTests(unittest.TestCase):
    def test_only_one_process_and_crash_releases_without_deleting_file(self):
        with TemporaryDirectory() as temp:
            path = str(Path(temp) / 'directory.refresh.lock')
            first = RefreshLock(path)
            code = 'from sfera_mesh.refresh_lock import RefreshLock; import sys; lock=RefreshLock(sys.argv[1]); print(lock.acquire(), flush=True)'
            self.assertTrue(first.acquire())
            try:
                result = subprocess.run([sys.executable, '-c', code, path], capture_output=True, timeout=10, check=True)
                self.assertEqual(result.stdout.strip(), b'False')
            finally:
                first.release()
            child = subprocess.Popen([sys.executable, '-c', code + '; sys.stdin.read()', path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(child.stdout.readline().strip(), b'True')
                self.assertFalse(first.acquire())
                child.kill()
                child.wait(timeout=10)
                deadline = time.monotonic() + 3
                while not first.acquire() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(first.acquire())
                first.release()
                self.assertEqual(Path(path).read_bytes(), b'0')
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=10)
                first.release()
                child.stdin.close()
                child.stdout.close()
                child.stderr.close()

    def test_unexpected_filesystem_error_is_not_lock_contention(self):
        with TemporaryDirectory() as temp:
            lock = RefreshLock(str(Path(temp) / 'missing' / 'lock'))
            with self.assertRaises(OSError):
                lock.acquire()


if __name__ == '__main__':
    unittest.main()
