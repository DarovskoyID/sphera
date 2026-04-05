from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('ionik_auth.urls')),
    path('api/', include('ionik_messages.urls')),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
