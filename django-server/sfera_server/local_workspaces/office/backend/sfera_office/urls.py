from django.urls import path

from . import views

urlpatterns = [
    path('docs/', views.doc_list_create),
    path('docs/<uuid:doc_id>/', views.doc_detail),
    path('docs/<uuid:doc_id>/ops/', views.doc_ops),
    path('docs/<uuid:doc_id>/download/<str:fmt>/', views.doc_download),
    path('docs/<uuid:doc_id>/history/', views.doc_history),
    path('docs/<uuid:doc_id>/history/<uuid:revision_id>/restore/', views.doc_restore),
    path('docs/<uuid:doc_id>/comments/', views.comments),
    path('docs/<uuid:doc_id>/comments/<uuid:comment_id>/', views.comment_detail),
    path('docs/<uuid:doc_id>/members/', views.member_add),
    path('docs/<uuid:doc_id>/members/<uuid:user_id>/', views.member_detail),
    path('users/', views.user_search),
]
