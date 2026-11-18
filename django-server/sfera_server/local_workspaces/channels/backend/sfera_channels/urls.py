from django.urls import path

from . import views

urlpatterns = [
    path('', views.channel_list_create),
    path('explore/', views.channel_explore),
    path('search/posts/', views.post_search),
    path('join/', views.channel_join),
    path('<uuid:channel_id>/', views.channel_detail),
    path('<uuid:channel_id>/leave/', views.channel_leave),
    path('<uuid:channel_id>/notifications/', views.channel_notifications),
    path('<uuid:channel_id>/posts/', views.post_list_create),
    path('<uuid:channel_id>/rich/', views.post_rich_create),
    path('<uuid:channel_id>/schedule/', views.post_schedule),
    path('<uuid:channel_id>/upload/', views.upload),
    path('posts/<uuid:post_id>/', views.post_detail),
    path('posts/<uuid:post_id>/reactions/', views.post_reaction),
    path('posts/<uuid:post_id>/view/', views.post_view),
    path('posts/<uuid:post_id>/comments/', views.post_comments),
    path('posts/<uuid:post_id>/poll/vote/', views.poll_vote),
    path('posts/<uuid:post_id>/poll/voters/', views.poll_voters),
    path('posts/<uuid:post_id>/poll/close/', views.poll_close),
    path('posts/<uuid:post_id>/todo/toggle/', views.todo_toggle),
    path('posts/<uuid:post_id>/location/', views.location_update),
    path('comments/<uuid:comment_id>/', views.comment_delete),
    path('attachments/<uuid:attachment_id>/', views.download),
]
