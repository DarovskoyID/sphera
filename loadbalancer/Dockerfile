FROM nginx:1.27-alpine

# Убираем дефолтный конфиг и кладём свой
RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf   /etc/nginx/nginx.conf
COPY servers.conf /etc/nginx/servers.conf

EXPOSE 8001

# Проверка здоровья балансировщика.
# ВАЖНО: используем 127.0.0.1, а не localhost — внутри контейнера localhost
# может резолвиться в IPv6 (::1), а nginx слушает только IPv4 → ложный unhealthy.
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8001/lb-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
