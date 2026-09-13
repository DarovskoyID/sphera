import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'sfera_server.settings')
django.setup()

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import path
from sfera_server.middleware import JWTAuthMiddleware
from sfera_messages.consumers import ChatConsumer
from sfera_signaling.consumers import SignalingConsumer
from sfera_modules.loader import websocket_patterns as module_websocket_patterns

application = ProtocolTypeRouter({
    'http': get_asgi_application(),
    'websocket': JWTAuthMiddleware(
        URLRouter([
            path('ws/chat/<uuid:conversation_id>/', ChatConsumer.as_asgi()),
            path('ws/signaling/', SignalingConsumer.as_asgi()),
            *module_websocket_patterns(),
        ])
    ),
})
