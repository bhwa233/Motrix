#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
umask 077
exec >>"$MOTRIX_DATA_DIR/logs/server.log" 2>&1
cd "$ROOT/server"
# Download files inherit the Download/Motrix directory's shared group.
# State is protected by its private parent directories; tokens also use 0600.
umask 007
exec "$ROOT/runtime/bin/node" "$ROOT/server/dist/server/index.mjs"
