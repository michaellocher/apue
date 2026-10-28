#!/bin/sh
# Resumable uploads over emulated networks (bench/uploads-wan.ts), in the bench container with netem.
#   bench/uploads-wan.sh
set -eu
cd "$(dirname "$0")/.."
docker build -q -t apue-bench -f bench/Dockerfile . > /dev/null
for netem in "" "delay 25ms rate 100mbit" "delay 50ms rate 20mbit loss 0.1%"; do
  docker run --rm --cap-add NET_ADMIN -e NETEM="${netem:-loopback}" apue-bench sh -c \
    "${netem:+tc qdisc add dev lo root netem $netem && }node bench/uploads-wan.ts"
done
