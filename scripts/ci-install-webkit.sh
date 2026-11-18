#!/bin/sh
# Installs Playwright's WebKit and its system packages on a GitHub Actions Ubuntu runner (CI and
# Release). The packages (~125 MB, ~180 of them) come from an Ubuntu mirror, and the runner's
# regional one is sometimes very slow: the same download took 48 s on one run and stalled for over
# 17 minutes on the next. So:
# - apt uses the Azure mirror (azure.archive.ubuntu.com) first, Canonical's main archive on retries;
# - each attempt gets 5 minutes, three attempts at most; a retry continues where the last stopped;
# - apt downloads straight into ~/.cache/webkit-debs, which the workflows cache (with Playwright's
#   WebKit build in ~/.cache/ms-playwright): a warm run downloads only the package indexes and
#   whatever changed. Packages left in apt's own directory can be deleted after installing
#   (Ubuntu's Docker image does that), so the cache never relies on them.
set -u

debs="$HOME/.cache/webkit-debs"
mkdir -p "$debs/partial"
printf 'Dir::Cache::Archives "%s/";\nAPT::Keep-Downloaded-Packages "true";\n' "$debs" |
  sudo tee /etc/apt/apt.conf.d/99webkit-cache > /dev/null
echo "cached packages before: $(ls "$debs"/*.deb 2> /dev/null | wc -l)"

mirror() {
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do
    [ -f "$file" ] && sudo sed -i -E "s#https?://[^ /]*archive\\.ubuntu\\.com/ubuntu/?#$1#g" "$file"
  done
}
mirror http://azure.archive.ubuntu.com/ubuntu/

for attempt in 1 2 3; do
  # GNU timeout signals the whole process group: npx, the shell it starts and sudo, which relays
  # the signal to apt-get (checked in an ubuntu:24.04 container).
  if timeout -k 15 "${WEBKIT_ATTEMPT_SECONDS:-300}" npx playwright-core install --with-deps webkit; then
    echo "cached packages after: $(ls "$debs"/*.deb 2> /dev/null | wc -l)"
    exit 0
  fi
  echo "::warning::WebKit install attempt $attempt did not finish within ${WEBKIT_ATTEMPT_SECONDS:-300} s or failed"
  [ "$attempt" = 3 ] && break
  sudo pkill -x apt-get || true
  # A dpkg run that was already unpacking finishes on its own (killing it could break its
  # database); wait for it, then let dpkg finish anything left half configured.
  for _ in $(seq 1 60); do pgrep -x dpkg > /dev/null || break; sleep 2; done
  sudo dpkg --configure -a || true
  mirror http://archive.ubuntu.com/ubuntu/
done
echo "::error::WebKit could not be installed in 3 attempts"
exit 1
