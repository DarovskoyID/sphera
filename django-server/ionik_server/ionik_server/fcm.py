import logging
import firebase_admin
from firebase_admin import credentials, messaging
from django.conf import settings

logger = logging.getLogger(__name__)

_initialized = False


def _init():
    global _initialized
    if not _initialized and not firebase_admin._apps:
        cred = credentials.Certificate(settings.FIREBASE_CREDENTIALS)
        firebase_admin.initialize_app(cred)
        _initialized = True


def send_to_user(user_id, data: dict):
    """Send a high-priority data-only FCM push to every device registered for user_id."""
    try:
        _init()
    except Exception as e:
        # A bad/revoked serviceAccountKey.json lands here. Without this log the
        # failure is invisible and *no* notifications are ever delivered.
        logger.error('FCM init failed — pushes will NOT be delivered: %s', e)
        return
    from ionik_auth.models import FcmToken
    tokens = list(FcmToken.objects.filter(user_id=user_id).values_list('token', flat=True))
    if not tokens:
        logger.info('FCM: no registered tokens for user %s', user_id)
        return
    stale = []
    str_data = {k: str(v) for k, v in data.items()}
    for token in tokens:
        try:
            messaging.send(messaging.Message(
                token=token,
                android=messaging.AndroidConfig(priority='high'),
                data=str_data,
            ))
        except messaging.UnregisteredError:
            stale.append(token)
        except Exception as e:
            # Auth errors (e.g. 'Invalid JWT Signature' from a revoked key) surface
            # here per-token; log at error level so they are not lost.
            logger.error('FCM send error for %s: %s', token[:20], e)
    if stale:
        FcmToken.objects.filter(token__in=stale).delete()
