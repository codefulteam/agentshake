#!/usr/bin/env bash
# Host wrapper: runs two-uid.sh in a disposable, network-less Linux container.
#   bash test/isolation/build-image.sh   # once, needs network (see Dockerfile)
#   NODE_LINUX=/path/to/node-vXX-linux-<arch>  PKG_PREFIX=/path/with/node_modules/agentshake  bash test/isolation/run-container.sh
# PKG_PREFIX is an npm prefix where the packed tarball was installed. The run itself uses
# --network none and --pull never: the image must already exist locally (IMAGE to
# override). Nothing on the host is modified.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
IMAGE=${IMAGE:-agentshake-isolation:ubuntu24.04}
: "${NODE_LINUX:?set NODE_LINUX to a Linux Node.js directory}" "${PKG_PREFIX:?set PKG_PREFIX to the npm prefix with agentshake installed}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image $IMAGE not found. Build it first: bash test/isolation/build-image.sh" >&2
  exit 2
fi
MOUNTS=(-v "$NODE_LINUX:/opt/node:ro" -v "$PKG_PREFIX:/opt/pkg:ro"
  -v "$HERE:/opt/test:ro" -v "$HERE/mcp-client.mjs:/opt/client/mcp-client.mjs:ro" -v "$ROOT/node_modules:/opt/client/node_modules:ro")
# Preflight: fail with a clear message if the image cannot run this Node build
# (for example missing shared libraries), before the harness starts.
if ! docker run --rm --network none --pull never "${MOUNTS[@]}" "$IMAGE" /opt/node/bin/node --version; then
  echo "This Node.js build cannot run in $IMAGE (missing runtime libraries?). Rebuild the image with test/isolation/build-image.sh." >&2
  exit 2
fi
exec docker run --rm --network none --pull never "${MOUNTS[@]}" "$IMAGE" bash /opt/test/two-uid.sh
