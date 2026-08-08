from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from .models import User, Friendship, BlockedUser, UserDevice, UserSettings


admin.site.register(User, UserAdmin)
admin.site.register(Friendship)
admin.site.register(BlockedUser)
admin.site.register(UserDevice)


@admin.register(UserSettings)
class UserSettingsAdmin(admin.ModelAdmin):
    list_display = [
        'user',
        'show_profile_to_everyone', 'display_online_status', 'show_activity_status',
        'scan_messages_everyone', 'scan_messages_non_friends', 'scan_messages_off',
        'blur_enabled', 'blur_profanity', 'blur_calls_to_action',
        'blur_code_requests', 'blur_disable_requests',
        'enable_all_notifications', 'notify_direct_messages', 'notify_mentions',
        'notify_all_server_messages', 'notify_friend_requests',
        'sound_message', 'sound_incoming_call',
        'theme', 'show_timestamps', 'show_avatars',
        'auto_input_sensitivity', 'echo_cancellation', 'noise_suppression',
        'chat_show_timestamps', 'chat_emoji_reactions', 'chat_compact_mode',
        'data_app_improvements', 'data_personalization',
        'streamer_mode', 'streamer_hide_info', 'streamer_disable_notifs',
        'developer_mode', 'hardware_acceleration',
        'show_current_activity', 'show_game_status',
        'language',
    ]
    list_display_links = ['user']
    list_editable = [
        'show_profile_to_everyone', 'display_online_status', 'show_activity_status',
        'scan_messages_everyone', 'scan_messages_non_friends', 'scan_messages_off',
        'blur_enabled', 'blur_profanity', 'blur_calls_to_action',
        'blur_code_requests', 'blur_disable_requests',
        'enable_all_notifications', 'notify_direct_messages', 'notify_mentions',
        'notify_all_server_messages', 'notify_friend_requests',
        'sound_message', 'sound_incoming_call',
        'theme', 'show_timestamps', 'show_avatars',
        'auto_input_sensitivity', 'echo_cancellation', 'noise_suppression',
        'chat_show_timestamps', 'chat_emoji_reactions', 'chat_compact_mode',
        'data_app_improvements', 'data_personalization',
        'streamer_mode', 'streamer_hide_info', 'streamer_disable_notifs',
        'developer_mode', 'hardware_acceleration',
        'show_current_activity', 'show_game_status',
        'language',
    ]
    search_fields = ['user__username']
