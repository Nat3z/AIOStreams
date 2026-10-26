#!/usr/bin/env bash
# Deploys from this checkout to oci-selfhosted, which runs the stack. Edits
# happen here; oci builds the images itself, because it's arm64.
#
#   deploy/oci.sh [aiostreams|aiometadata|all]   # default: all
#
# OCI_HOST, OCI_DIR and AIOMETADATA_SRC override where things live.
set -euo pipefail

host=${OCI_HOST:-oracle}
dir=${OCI_DIR:-/srv/stacks/aio}
here=$(cd "$(dirname "$0")/.." && pwd)
meta=${AIOMETADATA_SRC:-$here/../aiometadata}
target=${1:-all}

case $target in
  aiostreams | aiometadata | all) ;;
  *) echo "usage: $0 [aiostreams|aiometadata|all]" >&2; exit 2 ;;
esac

oci() { ssh -o BatchMode=yes "$host" "$@" 2>/dev/null; }

# Leaves oci's deploy/.env alone: it holds the secrets.
sync() {
  local excludes=(--exclude node_modules --exclude .git --exclude dist)
  if [[ $target != aiometadata ]]; then
    rsync -az --delete "${excludes[@]}" --exclude dist-standalone \
      --exclude '*.tsbuildinfo' --exclude /data --exclude deploy/.env \
      "$here/" "$host:$dir/aiostreams/"
  fi
  if [[ $target != aiostreams ]]; then
    rsync -az --delete "${excludes[@]}" --exclude addon/data \
      "$meta/" "$host:$dir/aiometadata/"
  fi
}

healthy() {
  local service=$1 url=$2
  for _ in $(seq 60); do
    if oci docker exec "$service" wget -qO- "$url" >/dev/null; then
      echo "$service healthy"
      return 0
    fi
    sleep 5
  done
  echo "$service not healthy after 5 minutes" >&2
  oci docker logs --tail 30 "$service" >&2 || true
  return 1
}

free=$(oci df --output=avail -BG / | tail -1 | tr -dc 0-9)
if (( free < 3 )); then
  oci docker builder prune -af >/dev/null
fi

sync
services=()
[[ $target == all ]] || services=("$target")
oci "cd $dir/aiostreams && docker compose -f deploy/compose.yaml up -d --build ${services[*]}"

if [[ $target != aiometadata ]]; then
  healthy aiostreams http://localhost:3000/api/v1/health
fi
if [[ $target != aiostreams ]]; then
  healthy aio-aiometadata http://localhost:3232/health/live
fi
oci docker builder prune -af >/dev/null
