from django.urls import path

from . import views

urlpatterns = [
    path('status/', views.status),
    path('setup/', views.setup),
    path('confirm/', views.confirm),
    path('disable/', views.disable),
    path('backup-codes/', views.backup_codes),
    path('settings/', views.settings_view),
    path('people/', views.people),
    path('people/<uuid:user_id>/reset/', views.reset_user),
]
