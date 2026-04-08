from django.urls import path
from . import views

urlpatterns = [
    path('conversations/', views.conversation_list),
    path('conversations/create/', views.conversation_create),
    path('conversations/<int:conversation_id>/messages/', views.message_list),
    path('conversations/<int:conversation_id>/delete/', views.conversation_delete),
    path('conversations/<int:conversation_id>/upload/', views.upload_attachment),
    path('conversations/<int:conversation_id>/schedule/', views.schedule_message),
    path('conversations/<int:conversation_id>/scheduled/', views.list_scheduled),
    path('attachments/<int:attachment_id>/', views.download_attachment),
    path('messages/<int:message_id>/', views.delete_message),
    path('messages/<int:message_id>/pin/', views.pin_message),
    path('messages/<int:message_id>/report/', views.report_message),
    path('scheduled/<int:scheduled_id>/', views.cancel_scheduled_message),

    # Guilds (servers)
    path('guilds/', views.guild_list_create),
    path('guilds/join/', views.guild_join),
    path('guilds/<int:guild_id>/', views.guild_detail),
    path('guilds/<int:guild_id>/leave/', views.guild_leave),
    path('guilds/<int:guild_id>/kick/<int:user_id>/', views.guild_kick),
    path('guilds/<int:guild_id>/role/<int:user_id>/', views.guild_set_role),
    path('guilds/<int:guild_id>/channels/', views.guild_channel_list_create),
    path('guilds/<int:guild_id>/channels/<int:channel_id>/', views.guild_channel_delete),
    path('guilds/<int:guild_id>/channels/<int:channel_id>/messages/', views.guild_channel_messages),
    path('guilds/<int:guild_id>/messages/<int:message_id>/', views.guild_message_delete),
    path('guilds/<int:guild_id>/messages/<int:message_id>/pin/', views.guild_message_pin),
    path('guilds/<int:guild_id>/channels/<int:channel_id>/upload/', views.guild_upload_attachment),
    path('guilds/<int:guild_id>/channels/<int:channel_id>/schedule/', views.guild_schedule_message),
    path('guild-attachments/<int:attachment_id>/', views.guild_download_attachment),
    path('guilds/<int:guild_id>/voice-presence/', views.guild_voice_presence),
]
