from django.urls import path

from . import views

urlpatterns = [
    # Owner (JWT)
    path('', views.bots),
    path('unlock/', views.bot_unlock),
    path('<uuid:bot_id>/', views.bot_delete),
    path('<uuid:bot_id>/token/', views.bot_rotate_token),
    path('<uuid:bot_id>/commands/', views.bot_set_commands),
    path('<uuid:bot_id>/flow/', views.bot_flow),
    path('<uuid:bot_id>/guilds/<uuid:guild_id>/', views.bot_add_to_guild),
    path('<uuid:bot_id>/guilds/<uuid:guild_id>/remove/', views.bot_remove_from_guild),

    # Client UI (JWT)
    path('sferonik/', views.sferonik_chat),
    path('commands/', views.commands_for_chat),

    # Bot runtime (API key)
    path('api/me/', views.me),
    path('api/commands/', views.set_commands),
    path('api/updates/', views.get_updates),
    path('api/send/', views.send),
    path('api/edit/', views.edit),
    path('api/delete/', views.delete),
    path('api/chats/', views.chats),
]
