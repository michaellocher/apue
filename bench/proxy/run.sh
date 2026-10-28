#!/bin/sh
# Runs the apü intermediary probes through real nginx (Docker): client (host) → nginx (TLS, h2)
# → apü server container. Writes docs-ready Markdown to bench/results/proxy-nginx.md.
set -eu
cd "$(dirname "$0")/../.."
docker build -q -t apue-bench -f bench/Dockerfile . >/dev/null
certs=$(mktemp -d)
node --input-type=module -e "
import { testCert } from './test/helpers.ts';
import { writeFileSync } from 'node:fs';
const { key, cert } = testCert();
writeFileSync('$certs/key.pem', key); writeFileSync('$certs/cert.pem', cert);"
docker network create apue-proxy-net >/dev/null 2>&1 || true
docker rm -f apue apue-nginx >/dev/null 2>&1 || true
docker run -d --name apue --network apue-proxy-net apue-bench node bench/proxy/server.ts >/dev/null
out=bench/results/proxy-nginx.md
echo "nginx: $(docker run --rm --entrypoint nginx nginx:alpine -v 2>&1)" > "$out"
for variant in defaults tuned; do
  docker rm -f apue-nginx >/dev/null 2>&1 || true
  docker run -d --name apue-nginx --network apue-proxy-net -p 18443:443 \
    -v "$PWD/bench/proxy/nginx-$variant.conf:/etc/nginx/nginx.conf:ro" -v "$certs:/certs:ro" nginx:alpine >/dev/null
  sleep 1
  node bench/proxy/check.ts --url https://127.0.0.1:18443 --ca "$certs/cert.pem" --label "nginx, $variant config" | tee -a "$out"
done
docker rm -f apue apue-nginx >/dev/null
docker network rm apue-proxy-net >/dev/null
rm -rf "$certs"
