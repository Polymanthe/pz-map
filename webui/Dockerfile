FROM node:22-alpine AS frontend-dependencies

WORKDIR /app
COPY webui/package.json webui/package-lock.json ./
RUN npm ci --omit=dev

FROM alpine:3.22

RUN apk add --no-cache nginx nginx-mod-http-brotli

COPY webui/nginx.conf /etc/nginx/nginx.conf
COPY webui/public/ /usr/share/nginx/html/
COPY --from=frontend-dependencies /app/node_modules/leaflet/dist/ /usr/share/nginx/html/vendor/leaflet/

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
