#!/usr/bin/env bash
# Host wrapper: runs two-uid.sh in a disposable, network-less Linux container.
#   NODE_LINUX=/path/to/node-v24-linux-<arch>  PKG_PREFIX=/path/with/node_modules/agentshake  bash test/isolation/run-container.sh
# PKG_PREFIX is an npm prefix where the packed tarball was installed. Needs Docker and a
# local ubuntu:24.04 image (IMAGE to override). Nothing on the host is modified.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
IMAGE=${IMAGE:-ubuntu:24.04}
exec docker run --rm --network none --pull never \
  -v "$NODE_LINUX:/opt/node:ro" -v "$PKG_PREFIX:/opt/pkg:ro" \
  -v "$HERE:/opt/test:ro" -v "$HERE/mcp-client.mjs:/opt/client/mcp-client.mjs:ro" -v "$ROOT/node_modules:/opt/client/node_modules:ro" \
  "$IMAGE" bash /opt/test/two-uid.sh
