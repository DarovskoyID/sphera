from cryptography.fernet import Fernet
from django.conf import settings

_KEY = getattr(settings, 'MESSAGE_ENCRYPTION_KEY', None)
if not _KEY:
    raise RuntimeError('MESSAGE_ENCRYPTION_KEY must be set in settings.py')

_fernet = Fernet(_KEY)


def encrypt_text(plaintext: str) -> str:
    return _fernet.encrypt(plaintext.encode('utf-8')).decode('utf-8')


def decrypt_text(ciphertext: str) -> str:
    return _fernet.decrypt(ciphertext.encode('utf-8')).decode('utf-8')
