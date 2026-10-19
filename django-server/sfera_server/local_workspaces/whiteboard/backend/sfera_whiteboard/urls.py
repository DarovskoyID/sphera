from django.urls import path

from . import views

urlpatterns = [
    path('boards/', views.board_list_create),
    path('boards/<uuid:board_id>/', views.board_detail),
    path('boards/<uuid:board_id>/ops/', views.board_ops),
    path('boards/<uuid:board_id>/members/', views.member_add),
    path('boards/<uuid:board_id>/members/<uuid:user_id>/', views.member_detail),
    path('users/', views.user_search),
]
