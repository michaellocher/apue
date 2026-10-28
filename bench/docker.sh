#!/bin/sh
# Constrained-machine benchmarks: the server runs in a CPU/memory-limited container, the client in
# a second container sharing its network namespace (localhost + cert work, CPU limits stay separate).
# Optional netem on lo emulates latency/bandwidth for both directions.
#   bench/docker.sh            # all profiles
#   bench/docker.sh 1cpu-1g    # one profile
set -eu
cd "$(dirname "$0")/.."
mkdir -p bench/results
docker build -q -t apue-bench -f bench/Dockerfile . >/dev/null

run_profile() {
  label=$1 cpus=$2 mem=$3 netem=$4 only=$5 streamn=$6
  docker rm -f apue-server >/dev/null 2>&1 || true
  docker run -d --name apue-server --cpus="$cpus" --memory="$mem" --memory-swap="$mem" --cap-add NET_ADMIN \
    apue-bench node bench/server.ts --key certs/key.pem --cert certs/cert.pem --port-apue 8443 --port-raw 8444 >/dev/null
  for _ in $(seq 1 50); do docker logs apue-server 2>/dev/null | grep -q '"apue"' && break; sleep 0.2; done
  rtt=loopback
  if [ -n "$netem" ]; then
    docker exec apue-server tc qdisc add dev lo root netem $netem
    rtt="$(docker exec apue-server ping -c 5 -q 127.0.0.1 | tail -1 | cut -d/ -f5) ms RTT (measured)"
  fi
  notes="server container: $cpus CPU, $mem RAM; network: ${netem:-loopback} → $rtt"
  docker run --rm --network container:apue-server -v "$PWD/bench/results:/app/bench/results" apue-bench \
    node bench/run.ts --remote 8443,8444 --ca certs/cert.pem --label "docker-$label" --notes "$notes" \
      --only "$only" --stream-n "$streamn" --duration 3000 | tee "bench/results/docker-$label.md"
  docker stats --no-stream --format 'server peak-ish memory: {{.MemUsage}}' apue-server | tee -a "bench/results/docker-$label.md"
  docker rm -f apue-server >/dev/null
}

ALL=unary,stream,bulk,chain,compression,window
want=${1:-all}
[ "$want" = all ] || [ "$want" = 2cpu-1g ] && run_profile 2cpu-1g 2 1g "" "$ALL" 200000
[ "$want" = all ] || [ "$want" = 1cpu-1g ] && run_profile 1cpu-1g 1 1g "" "$ALL" 200000
[ "$want" = all ] || [ "$want" = 0.5cpu-256m ] && run_profile 0.5cpu-256m 0.5 256m "" "$ALL" 100000
[ "$want" = all ] || [ "$want" = 1cpu-1g-wan ] && run_profile 1cpu-1g-wan 1 1g "delay 25ms rate 100mbit" "$ALL" 100000
true
