"""Publisher key custody: Windows current-user DPAPI, never plaintext key files."""
import ctypes
from ctypes import wintypes
import os
import getpass
from pathlib import Path
from cryptography.hazmat.primitives import serialization


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(raw, protect):
    if os.name != 'nt': raise RuntimeError('DPAPI publisher keys require Windows; use an offline signer on other hosts')
    buffer = ctypes.create_string_buffer(raw)
    source = Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    fn = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ctypes.WinError()
    try: return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree(ctypes.cast(target.data, ctypes.c_void_p))
        ctypes.memset(buffer, 0, len(raw))


def save_key(path, key):
    path = Path(path)
    if not path.is_absolute() or path.exists() or path.is_symlink() or not path.parent.is_dir(): raise ValueError('new_private_key_path_required')
    if path.name.endswith('.pk8.enc'):
        password=getpass.getpass('Portable signing key password: ')
        if len(password)<16 or getpass.getpass('Repeat password: ')!=password: raise ValueError('long_matching_key_password_required')
        encrypted=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.BestAvailableEncryption(password.encode('utf-8')))
    else:
        raw = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        encrypted = _dpapi(raw, True)
    descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(descriptor,'wb') as output:
        output.write(encrypted); output.flush(); os.fsync(output.fileno())


def load_key(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16384: raise ValueError('invalid_protected_key_file')
    raw=path.read_bytes()
    if path.name.endswith('.pk8.enc'):
        if not raw.startswith(b'-----BEGIN ENCRYPTED PRIVATE KEY-----'): raise ValueError('encrypted_portable_key_required')
        password=getpass.getpass('Portable signing key password: ')
        return serialization.load_pem_private_key(raw,password.encode('utf-8'))
    return serialization.load_der_private_key(_dpapi(raw, False), password=None)
