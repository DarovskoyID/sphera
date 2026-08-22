from django.contrib import admin

from .models import BotAccount, BotFlow, BotUpdate


@admin.register(BotAccount)
class BotAccountAdmin(admin.ModelAdmin):
    list_display = ('display_name', 'user', 'owner', 'api_tier', 'is_active', 'is_system', 'created_at')
    list_filter = ('api_tier', 'is_active', 'is_system')
    list_editable = ('api_tier',)
    search_fields = ('display_name', 'user__username', 'owner__username')
    readonly_fields = ('token_hash', 'token_prefix', 'created_at', 'revoked_at')


@admin.register(BotFlow)
class BotFlowAdmin(admin.ModelAdmin):
    list_display = ('bot', 'updated_at')


@admin.register(BotUpdate)
class BotUpdateAdmin(admin.ModelAdmin):
    list_display = ('id', 'bot', 'update_type', 'created_at')
    list_filter = ('update_type',)
