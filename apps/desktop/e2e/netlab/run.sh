#!/bin/sh
# Builds the native peer and runs the router matrix. Needs root (namespaces, iptables).
set -eu
cd "$(dirname "$0")/../../src-tauri"
# tauri::generate_context needs the frontend dist and resources to exist; the peer itself uses neither.
mkdir -p ../../web/dist resources/node resources/worker
[ -f ../../web/dist/index.html ] || echo '<!doctype html>' > ../../web/dist/index.html
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo build --example rtc_cli
bin="${CARGO_TARGET_DIR:-target}/debug/examples/rtc_cli"
NETLAB_OUT="${NETLAB_OUT:-/tmp/netlab-result.json}" node ../e2e/netlab/matrix.mjs "$bin"
