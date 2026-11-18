from django.urls import path

from .consumers import ChannelFeedConsumer

websocket_urlpatterns = [
    path('ws/m/channels/<uuid:channel_id>/', ChannelFeedConsumer.as_asgi()),
]
