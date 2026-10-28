#!/bin/sh
# Runs the apü intermediary probes through real proxies (Docker): client (host) → proxy (TLS, h2)
# → apü server container. Writes Markdown per proxy to bench/results/proxy-<name>.md.
#   bench/proxy/run.sh [nginx|caddy|haproxy|envoy]...   (default: all)
set -eu
cd "$(dirname "$0")/../.."
docker build -q -t apue-bench -f bench/Dockerfile . >/dev/null
certs=$(mktemp -d)
node --input-type=module -e "
import { testCert } from './test/helpers.ts';
import { writeFileSync } from 'node:fs';
const { key, cert } = testCert();
writeFileSync('$certs/key.pem', key); writeFileSync('$certs/cert.pem', cert); writeFileSync('$certs/combined.pem', cert + key);"
chmod 755 "$certs"; chmod 644 "$certs"/*.pem # proxies run as unprivileged users
docker network create apue-proxy-net >/dev/null 2>&1 || true
docker rm -f apue apue-proxy >/dev/null 2>&1 || true
docker run -d --name apue --network apue-proxy-net apue-bench node bench/proxy/server.ts >/dev/null

probe() { # $1 = label, $2 = image, $3 = config file, $4 = mount target, $5 = results file
  docker rm -f apue-proxy >/dev/null 2>&1 || true
  docker run -d --name apue-proxy --network apue-proxy-net -p 18443:443 \
    -v "$PWD/$3:$4:ro" -v "$certs:/certs:ro" "$2" >/dev/null
  for _ in $(seq 1 50); do curl -sk -o /dev/null https://127.0.0.1:18443/ 2>/dev/null && break; sleep 0.2; done
  node bench/proxy/check.ts --url https://127.0.0.1:18443 --ca "$certs/cert.pem" --label "$1" | tee -a "$5"
}

for proxy in ${*:-nginx caddy haproxy envoy}; do
  out=bench/results/proxy-$proxy.md
  case $proxy in
    nginx)
      echo "version: $(docker run --rm --entrypoint nginx nginx:alpine -v 2>&1)" > "$out"
      probe "nginx, defaults config" nginx:alpine bench/proxy/nginx-defaults.conf /etc/nginx/nginx.conf "$out"
      probe "nginx, tuned config" nginx:alpine bench/proxy/nginx-tuned.conf /etc/nginx/nginx.conf "$out" ;;
    caddy)
      echo "version: $(docker run --rm caddy:alpine caddy version | cut -d' ' -f1)" > "$out"
      probe "Caddy, defaults config" caddy:alpine bench/proxy/caddy-defaults.Caddyfile /etc/caddy/Caddyfile "$out" ;;
    haproxy)
      echo "version: $(docker run --rm haproxy:alpine haproxy -v | head -1)" > "$out"
      probe "HAProxy, defaults config" haproxy:alpine bench/proxy/haproxy-defaults.cfg /usr/local/etc/haproxy/haproxy.cfg "$out" ;;
    envoy)
      echo "version: $(docker run --rm envoyproxy/envoy:v1.40-latest --version 2>&1 | grep -o 'version: [^ ]*' | head -1)" > "$out"
      probe "Envoy, defaults config" envoyproxy/envoy:v1.40-latest bench/proxy/envoy-defaults.yaml /etc/envoy/envoy.yaml "$out"
      probe "Envoy, tuned config" envoyproxy/envoy:v1.40-latest bench/proxy/envoy-tuned.yaml /etc/envoy/envoy.yaml "$out" ;;
  esac
done
docker rm -f apue apue-proxy >/dev/null
docker network rm apue-proxy-net >/dev/null
rm -rf "$certs"
