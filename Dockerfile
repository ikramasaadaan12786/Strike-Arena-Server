FROM node:20-alpine
WORKDIR /app
COPY strike-arena-server/package*.json ./
RUN npm install --production
COPY strike-arena-server/server.js ./
COPY shared/ /build-shared/
RUN mkdir -p /shared && \
    if [ -f /build-shared/map.json ]; then cp /build-shared/*.json /shared/; \
    elif [ -f /build-shared/shared/map.json ]; then cp /build-shared/shared/*.json /shared/; \
    else echo "ERROR: shared data not found" && ls -R /build-shared && exit 1; fi && \
    rm -rf /build-shared
EXPOSE 10000
CMD ["node", "server.js"]

