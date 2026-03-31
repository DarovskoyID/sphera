from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('ionik_auth.urls')),
    path('api/', include('ionik_messages.urls')),
]
