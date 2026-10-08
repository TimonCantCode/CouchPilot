#!/bin/sh
# Update Couchpilot: sh update.sh
# The build runs the type check and unit tests first. If something fails, the old version keeps running.
set -e
cd "$(dirname "$0")"
git pull --ff-only
if ! docker compose build; then
  echo "Build or tests failed, nothing was changed. The old version is still running."
  exit 1
fi
docker compose up -d
docker image prune -f >/dev/null
docker compose ps
