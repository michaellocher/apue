#!/bin/sh
# Installs Playwright's WebKit and its system packages on a GitHub Actions Ubuntu runner (CI and
# Release). The packages (~125 MB, ~180 of them) come from the runner's regional Ubuntu mirror,
# which is sometimes very slow: the same download took 48 s on one run and stalled for over 17
# minutes on the next. So each attempt gets 5 minutes; apt keeps every package it finished, so a
# retry continues where the last one stopped, and from the second attempt on apt uses Canonical's
# main archive instead of the regional mirror.
set -u

for attempt in 1 2 3; do
  # GNU timeout signals the whole process group: npx, the shell it starts and sudo, which relays
  # the signal to apt-get (checked in an ubuntu:24.04 container).
  if timeout -k 15 "${WEBKIT_ATTEMPT_SECONDS:-300}" npx playwright-core install --with-deps webkit; then
    exit 0
  fi
  echo "::warning::WebKit install attempt $attempt did not finish within ${WEBKIT_ATTEMPT_SECONDS:-300} s or failed"
  [ "$attempt" = 3 ] && break
  sudo pkill -x apt-get || true
  # A dpkg run that was already unpacking finishes on its own (killing it could break its
  # database); wait for it, then let dpkg finish anything left half configured.
  for _ in $(seq 1 60); do pgrep -x dpkg > /dev/null || break; sleep 2; done
  sudo dpkg --configure -a || true
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
    [ -f "$file" ] && sudo sed -i -E 's#https?://[^ /]*archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' "$file"
  done
done
echo "::error::WebKit could not be installed in 3 attempts"
exit 1
