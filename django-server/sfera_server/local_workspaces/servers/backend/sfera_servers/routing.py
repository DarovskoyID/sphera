from django.urls import path

from .consumers import GuildChannelConsumer, GuildPresenceConsumer, GuildVoiceConsumer

websocket_urlpatterns = [
    path('ws/guild/<uuid:guild_id>/', GuildPresenceConsumer.as_asgi()),
    path('ws/guild/<uuid:guild_id>/channel/<uuid:channel_id>/', GuildChannelConsumer.as_asgi()),
    path('ws/guild/<uuid:guild_id>/voice/<uuid:channel_id>/', GuildVoiceConsumer.as_asgi()),
]
