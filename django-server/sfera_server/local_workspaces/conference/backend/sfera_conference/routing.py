from django.urls import path

from .consumers import ConferenceConsumer

websocket_urlpatterns = [
    path('ws/m/conference/<str:slug>/', ConferenceConsumer.as_asgi()),
]
