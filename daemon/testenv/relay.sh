#!/usr/bin/env bash
# Manage the ephemeral chatmail relay container for Headwater integration tests.
#
#   relay.sh build   build the image (idempotent; podman layer cache)
#   relay.sh up      (re)start a fresh relay, wait until healthy, print exports
#   relay.sh down    force-remove the relay container
#
# The container runs systemd (podman --systemd=always) with tmpfs-backed mail
# state, so every `up` is a clean slate. Ports are published to localhost only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${HEADWATER_RELAY_IMAGE:-${DELTANET_RELAY_IMAGE:-headwater-test-relay:latest}}"
CONTAINER="${HEADWATER_RELAY_CONTAINER:-${DELTANET_RELAY_CONTAINER:-headwater-test-relay}}"
MAIL_DOMAIN="${HEADWATER_RELAY_MAIL_DOMAIN:-${DELTANET_RELAY_MAIL_DOMAIN:-_chatmail.example}}"

# Published host ports (localhost only). Non-privileged so no root needed.
HOST="${HEADWATER_TEST_RELAY_HOST:-${DELTANET_TEST_RELAY_HOST:-127.0.0.1}}"
HTTPS_PORT="${HEADWATER_TEST_RELAY_HTTPS_PORT:-${DELTANET_TEST_RELAY_HTTPS_PORT:-8443}}"
IMAPS_PORT="${HEADWATER_TEST_RELAY_IMAPS_PORT:-${DELTANET_TEST_RELAY_IMAPS_PORT:-9993}}"
SMTPS_PORT="${HEADWATER_TEST_RELAY_SMTPS_PORT:-${DELTANET_TEST_RELAY_SMTPS_PORT:-9465}}"

# Container-internal ports (chatmail defaults).
C_HTTPS=443
C_IMAPS=993
C_SMTPS=465

READY_TIMEOUT="${HEADWATER_RELAY_READY_TIMEOUT:-${DELTANET_RELAY_READY_TIMEOUT:-300}}"

log() { echo "[relay.sh] $*" >&2; }

build() {
    log "building image $IMAGE (first build clones+installs the relay; this takes a while)"
    podman build -t "$IMAGE" -f "$SCRIPT_DIR/Containerfile" "$SCRIPT_DIR"
    log "build complete"
}

ensure_image() {
    if ! podman image exists "$IMAGE"; then
        build
    fi
}

down() {
    log "removing container $CONTAINER (if present)"
    podman rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

# POST /new over HTTPS, ignoring the self-signed cert. Echoes the JSON body.
try_new() {
    curl -sk --max-time 10 -X POST "https://${HOST}:${HTTPS_PORT}/new" 2>/dev/null || true
}

# Probe an IMAPS TLS handshake by issuing a CAPABILITY command over imaps://
# with curl (self-signed cert accepted via -k). A successful TLS handshake +
# IMAP response prints the capability line and exits 0; a connection/TLS
# failure exits non-zero. Non-blocking (curl --max-time bounds it).
try_imaps() {
    curl -sk --max-time 8 "imaps://${HOST}:${IMAPS_PORT}/" -X 'CAPABILITY' 2>/dev/null \
        | grep -qi 'CAPABILITY\|IMAP'
}

wait_ready() {
    log "waiting up to ${READY_TIMEOUT}s for /new + IMAPS to come up"
    local deadline=$(( $(date +%s) + READY_TIMEOUT ))
    local body=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
        body="$(try_new)"
        if echo "$body" | grep -q '"email"' && echo "$body" | grep -q '"password"'; then
            if try_imaps; then
                log "relay is healthy (POST /new returned creds; IMAPS handshake OK)"
                return 0
            fi
            log "  /new OK but IMAPS not ready yet..."
        fi
        sleep 3
    done
    log "ERROR: relay did not become healthy within ${READY_TIMEOUT}s"
    log "--- last /new response: ---"
    log "$body"
    log "--- container logs (tail) ---"
    podman logs --tail 60 "$CONTAINER" >&2 2>&1 || true
    return 1
}

print_exports() {
    cat <<EOF
export HEADWATER_TEST_RELAY_URL=https://${HOST}:${HTTPS_PORT}
export HEADWATER_TEST_RELAY_HOST=${HOST}
export HEADWATER_TEST_RELAY_HTTPS_PORT=${HTTPS_PORT}
export HEADWATER_TEST_RELAY_IMAPS_PORT=${IMAPS_PORT}
export HEADWATER_TEST_RELAY_SMTPS_PORT=${SMTPS_PORT}
export DELTANET_TEST_RELAY_URL=https://${HOST}:${HTTPS_PORT}
export DELTANET_TEST_RELAY_HOST=${HOST}
export DELTANET_TEST_RELAY_HTTPS_PORT=${HTTPS_PORT}
export DELTANET_TEST_RELAY_IMAPS_PORT=${IMAPS_PORT}
export DELTANET_TEST_RELAY_SMTPS_PORT=${SMTPS_PORT}
EOF
}

up() {
    ensure_image
    down
    log "starting fresh relay container $CONTAINER"
    # --systemd=always: run systemd as PID 1.
    # tmpfs for /tmp,/run,/run/lock: required by systemd; mail state under
    #   /home/vmail is also tmpfs so every run is a clean slate.
    podman run -d --name "$CONTAINER" \
        --systemd=always \
        --tmpfs /tmp --tmpfs /run --tmpfs /run/lock \
        --tmpfs /home/vmail:rw,mode=0755 \
        -e MAIL_DOMAIN="$MAIL_DOMAIN" \
        -p "${HOST}:${HTTPS_PORT}:${C_HTTPS}" \
        -p "${HOST}:${IMAPS_PORT}:${C_IMAPS}" \
        -p "${HOST}:${SMTPS_PORT}:${C_SMTPS}" \
        "$IMAGE" >/dev/null
    wait_ready
    print_exports
}

case "${1:-}" in
    build) build ;;
    up)    up ;;
    down)  down ;;
    *)
        echo "usage: relay.sh {build|up|down}" >&2
        exit 2
        ;;
esac
