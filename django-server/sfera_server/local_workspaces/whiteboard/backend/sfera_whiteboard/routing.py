from django.urls import path

from .consumers import BoardConsumer

websocket_urlpatterns = [
    path('ws/m/whiteboard/<uuid:board_id>/', BoardConsumer.as_asgi()),
]
