#!/bin/sh
set -eu
QPKG_NAME=MotrixServer
CONF=/etc/config/qpkg.conf
# QTS invokes the /etc/init.d symlink, so resolve it before finding the root.
SCRIPT=$(readlink -f "$0")
ROOT=$(CDPATH= cd -- "$(dirname -- "$SCRIPT")" && pwd -P)
PORT=16880
MDXP_PORT=16881
DATA_DIR=
DOWNLOAD_DIR=
ALLOWED_SAVE_DIRS=
RUN_USER=admin
RUN_GROUP=
PUBLIC_URL=
HOST_LANGUAGE=zh-CN
OPERATOR_TOKEN_FILE=
[ ! -f "$ROOT/etc/motrix.conf" ] || . "$ROOT/etc/motrix.conf"
DATA_DIR=${DATA_DIR:-$(dirname "$(dirname "$ROOT")")/.motrix-server}
SHARE=$(/sbin/getcfg Download path -f /etc/config/smb.conf 2>/dev/null || true)
DOWNLOAD_DIR=${DOWNLOAD_DIR:-${SHARE:-/share/Download}/Motrix}
PIDFILE="$ROOT/run/server.pid"
LOCK="$ROOT/run/control.lock"

pid_alive() {
    [ -r "$PIDFILE" ] || return 1
    PID=$(cat "$PIDFILE")
    case "$PID" in ''|*[!0-9]*) return 1;; esac
    [ "$PID" -gt 1 ] || return 1
    kill -0 "$PID" 2>/dev/null
}

owns_pid() {
    pid_alive || return 1
    [ -r "/proc/$PID/cmdline" ] || return 1
    tr '\000' '\n' < "/proc/$PID/cmdline" | grep -Fx "$ROOT/server/dist/server/index.mjs" >/dev/null
}

prepare() {
    [ "$(id -u)" = 0 ] || { echo "Service control requires an administrator." >&2; return 1; }
    unset LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS NODE_PATH
    case "$DATA_DIR:$DOWNLOAD_DIR" in /*:/*) ;; *) echo "Data and download paths must be absolute." >&2; return 1;; esac
    [ "$(uname -m)" = x86_64 ] || { echo "This package requires x86_64." >&2; return 1; }
    case "$PORT:$MDXP_PORT" in *[!0-9:]*|:*) echo "Invalid service port." >&2; return 1;; esac
    [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] && [ "$MDXP_PORT" -ge 1024 ] && [ "$MDXP_PORT" -le 65535 ] && [ "$PORT" != "$MDXP_PORT" ]
    if ! id "$RUN_USER" >/dev/null 2>&1; then
        [ "$RUN_USER" != admin ] || { echo "QNAP admin account is unavailable." >&2; return 1; }
        /bin/adduser -S -D -H -h "$DATA_DIR/home" -s /bin/false -g "Motrix Server service" -G everyone "$RUN_USER"
    fi
    # Administrator mode is the default requested for existing NAS folders.
    RUN_GROUP=${RUN_GROUP:-$(id -gn "$RUN_USER")}
    mkdir -p "$ROOT/run" "$DATA_DIR/home" "$DATA_DIR/tmp" "$DATA_DIR/plugins" "$DATA_DIR/logs"
    if [ ! -d "$DOWNLOAD_DIR" ]; then
        mkdir -p "$DOWNLOAD_DIR"
        chown "$RUN_USER":everyone "$DOWNLOAD_DIR"
        chmod 2770 "$DOWNLOAD_DIR"
    fi
    # Only app-owned state is changed; never recurse into users' downloads.
    chown "$RUN_USER":administrators "$DATA_DIR" "$DATA_DIR/home" "$DATA_DIR/tmp" "$DATA_DIR/plugins" "$DATA_DIR/logs"
    chmod 2750 "$DATA_DIR" "$DATA_DIR/home" "$DATA_DIR/plugins" "$DATA_DIR/logs"
    chmod 0700 "$DATA_DIR/tmp"
    "$ROOT/runtime/lib/ld-musl-x86_64.so.1" --library-path "$ROOT/runtime/lib" "$ROOT/runtime/bin/node" "$ROOT/libexec/relocate.mjs" "$ROOT"
    # Optional custom tokens use the upstream environment provisioning contract.
    if [ -n "$OPERATOR_TOKEN_FILE" ]; then
        case "$OPERATOR_TOKEN_FILE" in /*) ;; *) echo "Operator token path must be absolute." >&2; return 1;; esac
        [ -f "$OPERATOR_TOKEN_FILE" ] && [ ! -L "$OPERATOR_TOKEN_FILE" ] || { echo "Operator token must be a regular file." >&2; return 1; }
        chmod 0600 "$OPERATOR_TOKEN_FILE"
        MOTRIX_OPERATOR_TOKEN=$(cat "$OPERATOR_TOKEN_FILE")
        [ -n "$MOTRIX_OPERATOR_TOKEN" ] || { echo "Operator token must not be empty." >&2; return 1; }
        export MOTRIX_OPERATOR_TOKEN
    fi
    export QNAP_QPKG="$QPKG_NAME"
    export NODE_ENV=production MOTRIX_DATA_DIR="$DATA_DIR" MOTRIX_TEMP_DIR="$DATA_DIR/tmp"
    export MOTRIX_PLUGIN_DIR="$DATA_DIR/plugins" MOTRIX_EXTRA_DIR="$ROOT/server/extra"
    export MOTRIX_ARIA2_BIN="$ROOT/server/bin/aria2c" MOTRIX_FINALIZE_FS_BIN="$ROOT/server/bin/motrix-finalize-fs"
    export MOTRIX_DEFAULT_SAVE_DIR="$DOWNLOAD_DIR" MOTRIX_ALLOWED_SAVE_DIRS="${ALLOWED_SAVE_DIRS:-$DOWNLOAD_DIR}"
    export MOTRIX_RENDERER_DIR="$ROOT/server/dist/renderer-web" MOTRIX_BUILTIN_PLUGIN_DIR="$ROOT/server/builtin-plugins"
    export MOTRIX_MDXP_HOST=127.0.0.1 MOTRIX_MDXP_PORT="$MDXP_PORT"
    export MOTRIX_PUBLIC_URL="$PUBLIC_URL" MOTRIX_HOST_LANGUAGE="$HOST_LANGUAGE" PORT
    export HOME="$DATA_DIR/home" TMPDIR="$DATA_DIR/tmp" SSL_CERT_FILE="$ROOT/runtime/certs/ca-certificates.crt"
    export PATH="$ROOT/bin:$ROOT/server/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

start_service() {
    ENABLED=$(/sbin/getcfg "$QPKG_NAME" Enable -u -d TRUE -f "$CONF" 2>/dev/null || true)
    ENABLED=${ENABLED:-TRUE}
    [ "$ENABLED" = TRUE ] || { echo "$QPKG_NAME is disabled."; return 1; }
    if owns_pid; then echo "Motrix Server is already running (PID $PID)."; return 0; fi
    prepare
    mkdir "$LOCK" 2>/dev/null || { echo "Another service operation is in progress." >&2; return 1; }
    trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT HUP INT TERM
    /bin/busybox start-stop-daemon -S -b -m -p "$PIDFILE" -c "$RUN_USER:$RUN_GROUP" -x "$ROOT/libexec/run-server.sh" >/dev/null 2>&1
    attempts=0
    while [ "$attempts" -lt 150 ]; do
        if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
            if [ "$(/sbin/getcfg "$QPKG_NAME" Install_Path -f "$CONF")" = "$ROOT" ]; then
                /sbin/setcfg "$QPKG_NAME" Web_Port "$PORT" -f "$CONF"
                /sbin/setcfg "$QPKG_NAME" Data_Dir "$DATA_DIR" -f "$CONF"
            fi
            echo "Motrix Server is ready on port $PORT (user $RUN_USER)."
            return 0
        fi
        pid_alive || { echo "Server exited; inspect $DATA_DIR/logs/server.log" >&2; return 1; }
        attempts=$((attempts + 1))
        sleep 1
    done
    echo "Server did not become healthy; inspect $DATA_DIR/logs/server.log" >&2
    stop_service
    return 1
}

stop_service() {
    if ! owns_pid; then rm -f "$PIDFILE"; echo "Motrix Server is stopped."; return 0; fi
    kill -TERM "$PID"
    attempts=0
    while owns_pid && [ "$attempts" -lt 120 ]; do
        sleep 1
        attempts=$((attempts + 1))
    done
    if owns_pid; then
        echo "Graceful stop timed out after 120 seconds." >&2
        return 1
    fi
    rm -f "$PIDFILE"
    echo "Motrix Server stopped cleanly."
}

case "${1:-}" in
    prepare) prepare;;
    start) start_service;;
    stop) stop_service;;
    restart) stop_service; start_service;;
    status) if owns_pid; then echo "Running (PID $PID), port $PORT, data $DATA_DIR"; else echo "Stopped"; exit 3; fi;;
    remove) stop_service; echo "Configuration, tasks and downloads are retained at $DATA_DIR and $DOWNLOAD_DIR.";;
    *) echo "Usage: $0 {start|stop|restart|status|prepare|remove}" >&2; exit 1;;
esac
