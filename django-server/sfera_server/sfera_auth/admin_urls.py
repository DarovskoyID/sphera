from django.urls import path

from . import admin_api

urlpatterns = [
    path('reports/', admin_api.reports),
    path('reports/<uuid:report_id>/resolve/', admin_api.resolve_report),
    path('bans/', admin_api.bans),
    path('bans/<uuid:user_id>/', admin_api.unban),
    path('users/', admin_api.users),
]
