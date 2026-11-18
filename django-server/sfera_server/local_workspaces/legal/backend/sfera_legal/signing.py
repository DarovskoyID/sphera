"""Signing a protocol: a code from an email, or a detached signature file."""
import secrets

from django.conf import settings as dj_settings
from django.core.mail import send_mail
from django.utils import timezone

from .chain import sha256
from .models import SignCode

CODE_TTL_MINUTES = 30
MAX_ATTEMPTS = 5
MAX_SIGNATURE_BYTES = 512 * 1024


def issue_code(package, email: str) -> str:
    """One live code per (protocol, email); returns the code for sending."""
    code = f'{secrets.randbelow(1_000_000):06d}'
    SignCode.objects.filter(package=package, email=email).delete()
    SignCode.objects.create(package=package, email=email, code=code)
    return code


def send_code(package, email: str, verify_url: str = '') -> None:
    code = issue_code(package, email)
    send_mail(
        subject=f'Подпись протокола переписки: код {code}',
        message=(
            f'Код для подписания протокола «{package.title}»: {code}\n\n'
            f'SHA-256 протокола: {package.content_hash}\n'
            f'Код проверки протокола: {package.code}\n'
            + (f'Проверить протокол: {verify_url}\n' if verify_url else '')
            + f'\nКод действует {CODE_TTL_MINUTES} минут. Если вы не подписывали протокол, просто не вводите код.'
        ),
        from_email=getattr(dj_settings, 'DEFAULT_FROM_EMAIL', None),
        recipient_list=[email],
        fail_silently=False,
    )


def check_code(package, email: str, code: str) -> tuple[bool, str]:
    row = SignCode.objects.filter(package=package, email=email).order_by('-created_at').first()
    if not row:
        return False, 'code_not_requested'
    if (timezone.now() - row.created_at).total_seconds() > CODE_TTL_MINUTES * 60:
        row.delete()
        return False, 'code_expired'
    if row.attempts >= MAX_ATTEMPTS:
        row.delete()
        return False, 'too_many_attempts'
    if not secrets.compare_digest(row.code, str(code or '')):
        row.attempts += 1
        row.save(update_fields=['attempts'])
        return False, 'code_wrong'
    row.delete()
    return True, ''


def inspect_signature(data: bytes) -> dict:
    """What can be read from a detached signature without trusting it.

    Sfera stores the file and reads the certificate out of a PKCS#7/CMS
    container when the library can parse it. It does **not** verify the
    cryptography: Russian GOST algorithms are not supported by the library, and
    a court-appointed expert checks the stored file with their own tools. The
    protocol says exactly that, so nobody is misled.
    """
    out = {
        'fingerprint': sha256(data),
        'subject': '', 'serial': '', 'cert_fingerprint': '', 'valid_to': None,
        'note': 'Файл подписи сохранён. Криптографическая проверка (в том числе ГОСТ) выполняется экспертом.',
    }
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.serialization import pkcs7

        loader = pkcs7.load_der_pkcs7_certificates if not data.lstrip().startswith(b'-----') else pkcs7.load_pem_pkcs7_certificates
        certs = loader(data)
        if certs:
            cert = certs[0]
            out['subject'] = cert.subject.rfc4514_string()[:400]
            out['serial'] = format(cert.serial_number, 'x')[:80]
            out['cert_fingerprint'] = cert.fingerprint(hashes.SHA256()).hex()
            out['valid_to'] = cert.not_valid_after_utc
            out['note'] = 'Сертификат из файла подписи прочитан; криптографическая проверка выполняется экспертом.'
    except Exception:
        pass
    return out
