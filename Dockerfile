FROM node:20-alpine
WORKDIR /app
COPY strike-arena-server/package*.json ./
RUN npm install --production
COPY strike-arena-server/server.js ./
COPY shared/ /shared/
EXPOSE 10000
CMD ["node", "server.js"]
