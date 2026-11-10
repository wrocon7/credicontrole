FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# o app roda sem privilégios de administrador dentro do contêiner; /app/dados é para o banco embutido, se for usado
RUN mkdir -p /app/dados && chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 3300
CMD ["node", "server.js"]
