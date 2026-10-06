# Сервер заявок без зависимостей — нужен только Node 18+.
# Сборка:  docker build -t artmoto23-orders .
# Запуск:  docker run -p 8080:8080 --env-file .env artmoto23-orders
FROM node:22-alpine

WORKDIR /app

# package.json без зависимостей: npm install не нужен, образ собирается мгновенно.
COPY package.json ./
COPY server.js pricing.js index.html ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOG_ORDERS=0

EXPOSE 8080

# Проверка живости: контейнер сам себя диагностирует средствами Node.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
