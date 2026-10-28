# Bench image: Node 26 on Alpine, no npm install (no runtime dependencies), tc for netem.
FROM node:26-alpine
RUN apk add --no-cache openssl iproute2 iputils-ping
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY bench ./bench
COPY test/helpers.ts ./test/helpers.ts
RUN mkdir certs && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 \
      -keyout certs/key.pem -out certs/cert.pem -subj /CN=localhost \
      -addext subjectAltName=DNS:localhost,IP:127.0.0.1 2>/dev/null
