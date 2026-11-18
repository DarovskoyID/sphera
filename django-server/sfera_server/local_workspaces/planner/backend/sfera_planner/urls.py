from django.urls import path

from . import views

urlpatterns = [
    path('projects/', views.project_list_create),
    path('projects/<uuid:project_id>/', views.project_detail),
    path('projects/<uuid:project_id>/members/', views.member_add),
    path('projects/<uuid:project_id>/members/<uuid:user_id>/', views.member_detail),
    path('projects/<uuid:project_id>/columns/', views.column_create),
    path('projects/<uuid:project_id>/tasks/', views.task_create),
    path('columns/<uuid:column_id>/', views.column_detail),
    path('tasks/<uuid:task_id>/', views.task_detail),
    path('tasks/<uuid:task_id>/comments/', views.task_comments),
    path('my/', views.my_tasks),
    path('reminders/', views.reminders_due),
    path('users/', views.user_search),
]
