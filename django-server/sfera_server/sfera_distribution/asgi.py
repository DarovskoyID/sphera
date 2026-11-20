"""One entry process serves HTTP and authenticated realtime channels."""
import os
os.environ.setdefault('DJANGO_SETTINGS_MODULE','sfera_distribution.settings')
from django.core.asgi import get_asgi_application
http_application=get_asgi_application()
from channels.routing import ProtocolTypeRouter,URLRouter
from django.urls import path
from sfera_server.middleware import JWTAuthMiddleware
from sfera_messages.consumers import ChatConsumer
from sfera_signaling.consumers import SignalingConsumer
from sfera_modules.loader import websocket_patterns

application=ProtocolTypeRouter({
    'http':http_application,
    'websocket':JWTAuthMiddleware(URLRouter([
        path('ws/chat/<uuid:conversation_id>/',ChatConsumer.as_asgi()),
        path('ws/signaling/',SignalingConsumer.as_asgi()),
        *websocket_patterns(),
    ])),
})
