#!/usr/bin/env bash
# Builds the isolation test image. This is the only step that uses the network (pulling the
# pinned base image); nothing else is downloaded, and run-container.sh then runs offline.
#   bash test/isolation/build-image.sh            # tag: agentshake-isolation:ubuntu24.04
#   IMAGE=my-tag BASE=<image with libatomic1> BUILD_TIMEOUT=600 bash test/isolation/build-image.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-agentshake-isolation:ubuntu24.04}
BASE=${BASE:-buildpack-deps@sha256:890e8b5c0040e1deff5cc7dc7b4414e67069f79e3301afc4ec5bd49d64ef13e5}
BUILD_TIMEOUT=${BUILD_TIMEOUT:-600}
# A stalled registry must fail within a bound, not consume the whole CI job.
BOUND=()
if command -v timeout >/dev/null; then BOUND=(timeout "$BUILD_TIMEOUT"); fi
"${BOUND[@]}" docker build --build-arg "BASE=$BASE" -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
echo "built $IMAGE from $BASE"
