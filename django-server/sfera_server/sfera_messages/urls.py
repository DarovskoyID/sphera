from functools import wraps

from asgiref.sync import sync_to_async
from django.urls import path
from . import views


def par(view):
    """Run a hot sync DRF view in asgiref's thread pool instead of the single
    thread-sensitive ASGI thread, so requests to it process concurrently.

    Django wraps plain sync views with sync_to_async(thread_sensitive=True) →
    they all serialize on one thread (throughput ≈ 1/latency). Returning a
    coroutine here makes Django await it directly; the DRF view then runs in a
    genuine worker thread (thread_sensitive=False) exactly like under WSGI —
    concurrency is bounded by the pool (~cpu+4), keeping DB connections in check.
    Only apply to hot, self-contained read/write endpoints."""
    @wraps(view)
    async def _wrapped(request, *args, **kwargs):
        return await sync_to_async(view, thread_sensitive=False)(request, *args, **kwargs)
    _wrapped.csrf_exempt = getattr(view, 'csrf_exempt', True)
    return _wrapped


urlpatterns = [
    path('conversations/', par(views.conversation_list)),
    path('conversations/create/', views.conversation_create),
    path('conversations/<uuid:conversation_id>/messages/', par(views.message_list)),
    path('conversations/<uuid:conversation_id>/messages/send/', par(views.send_message)),
    path('conversations/<uuid:conversation_id>/delete/', views.conversation_delete),
    path('conversations/<uuid:conversation_id>/upload/', views.upload_attachment),
    path('conversations/<uuid:conversation_id>/schedule/', views.schedule_message),
    path('conversations/<uuid:conversation_id>/scheduled/', views.list_scheduled),
    path('ws/authorize/', views.ws_authorize),
    path('turn/', views.turn_credentials),
    path('attachments/<uuid:attachment_id>/', views.download_attachment),
    path('messages/<uuid:message_id>/', views.delete_message),
    path('messages/<uuid:message_id>/pin/', views.pin_message),
    path('messages/<uuid:message_id>/report/', views.report_message),

    # Rich messages in DMs (checklist / contact / location)
    path('conversations/<uuid:conversation_id>/rich/', par(views.conversation_rich_send)),
    path('messages/<uuid:message_id>/todo/toggle/', views.dm_todo_toggle),
    path('messages/<uuid:message_id>/location/', views.dm_location_update),
    path('scheduled/<uuid:scheduled_id>/', views.cancel_scheduled_message),
]
