from django.urls import path

from sfera_messages.urls import par

from . import views

urlpatterns = [
    # Server-bar layout (ordering + folders), synced per user
    path('server-layout/', views.server_layout),
    # Guilds (servers)
    path('guilds/', par(views.guild_list_create)),
    path('guilds/explore/', views.guild_explore),
    path('guilds/join/', views.guild_join),
    path('guilds/<uuid:guild_id>/', views.guild_detail),
    path('guilds/<uuid:guild_id>/leave/', views.guild_leave),
    path('guilds/<uuid:guild_id>/kick/<uuid:user_id>/', views.guild_kick),
    path('guilds/<uuid:guild_id>/members/<uuid:user_id>/mute/', views.guild_mute_member),
    path('guilds/<uuid:guild_id>/role/<uuid:user_id>/', views.guild_set_role),
    path('guilds/<uuid:guild_id>/categories/', views.guild_category_create),
    path('guilds/<uuid:guild_id>/categories/<uuid:category_id>/', views.guild_category_delete),
    path('guilds/<uuid:guild_id>/notifications/', views.guild_toggle_notifications),
    path('guilds/<uuid:guild_id>/channels/', views.guild_channel_list_create),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/', views.guild_channel_detail),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/messages/', par(views.guild_channel_messages)),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/messages/send/', par(views.guild_channel_send)),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/', views.guild_message_delete),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/pin/', views.guild_message_pin),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/reactions/', par(views.guild_message_reaction)),
    # Rich messages in guild channels (poll / checklist / contact / location)
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/rich/', par(views.guild_channel_rich_send)),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/poll/vote/', par(views.guild_poll_vote)),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/poll/voters/', views.guild_poll_voters),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/poll/close/', views.guild_poll_close),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/todo/toggle/', par(views.guild_todo_toggle)),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/location/', views.guild_location_update),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/view/', par(views.guild_message_view)),
    path('search/messages/', views.search_messages_view),
    path('guilds/<uuid:guild_id>/messages/<uuid:message_id>/comments/', par(views.guild_message_comments)),
    path('guilds/<uuid:guild_id>/comments/<uuid:comment_id>/', views.guild_comment_delete),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/upload/', views.guild_upload_attachment),
    path('guilds/<uuid:guild_id>/channels/<uuid:channel_id>/schedule/', views.guild_schedule_message),
    path('guild-attachments/<uuid:attachment_id>/', views.guild_download_attachment),
    path('guilds/<uuid:guild_id>/voice-presence/', par(views.guild_voice_presence)),
    path('guilds/<uuid:guild_id>/emojis/', views.guild_emojis),
    path('guilds/<uuid:guild_id>/emojis/<uuid:emoji_id>/', views.guild_emoji_delete),
    path('guilds/<uuid:guild_id>/stickers/', views.guild_stickers),
    path('guilds/<uuid:guild_id>/stickers/<uuid:sticker_id>/', views.guild_sticker_delete),
    path('guilds/<uuid:guild_id>/sounds/', views.guild_sounds),
    path('guilds/<uuid:guild_id>/sounds/<uuid:sound_id>/', views.guild_sound_delete),
    path('guilds/<uuid:guild_id>/roles/', views.guild_roles),
    path('guilds/<uuid:guild_id>/roles/<uuid:role_id>/', views.guild_role_detail),
    path('guilds/<uuid:guild_id>/members/<uuid:user_id>/roles/<uuid:role_id>/', views.guild_member_role),
    path('guilds/<uuid:guild_id>/invites/', views.guild_invites),
    path('guilds/<uuid:guild_id>/invites/<uuid:invite_id>/', views.guild_invite_revoke),
    path('guilds/<uuid:guild_id>/audit-log/', views.guild_audit_log),
]
