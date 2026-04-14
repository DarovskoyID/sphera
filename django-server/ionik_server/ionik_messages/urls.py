from django.urls import path
from . import views

urlpatterns = [
    path('conversations/', views.conversation_list),
    path('conversations/create/', views.conversation_create),
    path('conversations/<uuid:conversation_id>/messages/', views.message_list),
    path('conversations/<uuid:conversation_id>/delete/', views.conversation_delete),
    path('conversations/<uuid:conversation_id>/upload/', views.upload_attachment),
    path('conversations/<uuid:conversation_id>/schedule/', views.schedule_message),
    path('conversations/<uuid:conversation_id>/scheduled/', views.list_scheduled),
    path('attachments/<uuid:attachment_id>/', views.download_attachment),
    path('messages/<uuid:message_id>/', views.delete_message),
    path('messages/<uuid:message_id>/pin/', views.pin_message),
    path('messages/<uuid:message_id>/report/', views.report_message),
    path('scheduled/<uuid:scheduled_id>/', views.cancel_scheduled_message),

    # Guilds (servers)
    path('guilds/', views.guild_list_create),
    path('guilds/join/', views.guild_join),
    path('guilds/<uuid:guild_id>/', views.guild_detail),
    path('guilds/<uuid:guild_id>/leave/', views.guild_leave),
    path('guilds/<uuid:guild_id>/kick/<uuid:user_id>/', views.guild_kick),
    path('guilds/<uuid:guild_id>/role/<uuid:user_id>/', views.guild_set_role),
    path('guilds/<uuid:guild_id>/channels/', views.guild_channel_list_create),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/', views.guild_channel_delete),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/messages/', views.guild_channel_messages),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/', views.guild_message_delete),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/pin/', views.guild_message_pin),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/upload/', views.guild_upload_attachment),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/schedule/', views.guild_schedule_message),
    path('guild-attachments/<uuid:attachment_id>/', views.guild_download_attachment),
    path('guilds/<uuid:guild_id>/voice-presence/', views.guild_voice_presence),
]
