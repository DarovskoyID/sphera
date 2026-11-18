from cryptography.fernet import Fernet, MultiFernet
from django.conf import settings

_KEY = getattr(settings, 'MESSAGE_ENCRYPTION_KEY', None)
if not _KEY:
    raise RuntimeError('MESSAGE_ENCRYPTION_KEY must be set in settings.py')

_OLD_KEYS = getattr(settings, 'OLD_MESSAGE_ENCRYPTION_KEYS', [])
_fernets = [Fernet(_KEY), *(Fernet(k) for k in _OLD_KEYS if k and k != _KEY)]
_primary_fernet = _fernets[0]
_multi_fernet = MultiFernet(_fernets)


def encrypt_text(plaintext: str) -> str:
    return _primary_fernet.encrypt(plaintext.encode('utf-8')).decode('utf-8')


def decrypt_text(ciphertext: str) -> str:
    return _multi_fernet.decrypt(ciphertext.encode('utf-8')).decode('utf-8')


def encrypt_bytes(data: bytes) -> bytes:
    return _primary_fernet.encrypt(data)


def decrypt_bytes(data: bytes) -> bytes:
    return _multi_fernet.decrypt(data)


def rotate_text(ciphertext: str) -> str:
    return _multi_fernet.rotate(ciphertext.encode('utf-8')).decode('utf-8')


def rotate_bytes(data: bytes) -> bytes:
    return _multi_fernet.rotate(data)
