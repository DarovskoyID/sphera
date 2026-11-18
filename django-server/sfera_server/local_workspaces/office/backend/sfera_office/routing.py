from django.urls import path

from .consumers import DocConsumer

websocket_urlpatterns = [
    path('ws/m/office/<uuid:doc_id>/', DocConsumer.as_asgi()),
]
