from django.urls import path
from . import views

urlpatterns = [
    path('conversations/', views.conversation_list),
    path('conversations/create/', views.conversation_create),
    path('conversations/<int:conversation_id>/messages/', views.message_list),
]
