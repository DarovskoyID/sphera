from django.urls import path

from . import views

urlpatterns = [
    path('diaries/', views.diary_list_create),
    path('diaries/<uuid:diary_id>/', views.diary_detail),
    path('diaries/<uuid:diary_id>/entries/', views.entry_list_create),
    path('diaries/<uuid:diary_id>/rich/', views.entry_rich_create),
    path('diaries/<uuid:diary_id>/upload/', views.upload),
    path('entries/<uuid:entry_id>/', views.entry_detail),
    path('entries/<uuid:entry_id>/poll/vote/', views.poll_vote),
    path('entries/<uuid:entry_id>/poll/close/', views.poll_close),
    path('entries/<uuid:entry_id>/todo/toggle/', views.todo_toggle),
    path('entries/<uuid:entry_id>/location/', views.location_update),
    path('attachments/<uuid:attachment_id>/', views.download),
]
