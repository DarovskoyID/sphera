import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'ionik_server.settings')
django.setup()

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import path
from ionik_server.middleware import JWTAuthMiddleware
from ionik_messages.consumers import ChatConsumer
from ionik_signaling.consumers import SignalingConsumer

application = ProtocolTypeRouter({
    'http': get_asgi_application(),
    'websocket': JWTAuthMiddleware(
        URLRouter([
            path('ws/chat/<int:conversation_id>/', ChatConsumer.as_asgi()),
            path('ws/signaling/', SignalingConsumer.as_asgi()),
        ])
    ),
})
