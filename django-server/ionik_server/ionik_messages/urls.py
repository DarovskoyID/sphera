from django.urls import path
from . import views

urlpatterns = [
    path('conversations/', views.conversation_list),
    path('conversations/create/', views.conversation_create),
    path('conversations/<int:conversation_id>/messages/', views.message_list),
    path('conversations/<int:conversation_id>/upload/', views.upload_attachment),
    path('attachments/<int:attachment_id>/', views.download_attachment),
    path('messages/<int:message_id>/', views.delete_message),
    path('messages/<int:message_id>/pin/', views.pin_message),
    path('messages/<int:message_id>/report/', views.report_message),
]
