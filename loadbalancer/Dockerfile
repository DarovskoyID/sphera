FROM nginx:1.27-alpine

# Убираем дефолтный конфиг и кладём свой
RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf   /etc/nginx/nginx.conf
COPY servers.conf /etc/nginx/servers.conf

EXPOSE 8001

# Проверка здоровья балансировщика
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
    CMD wget -qO- http://localhost:8001/lb-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
