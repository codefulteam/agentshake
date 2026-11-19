#!/usr/bin/env bash
# Builds the isolation test image. This is the only step that uses the network
# (base image and the libatomic1 package); run-container.sh then runs offline.
#   bash test/isolation/build-image.sh            # tag: agentshake-isolation:ubuntu24.04
#   IMAGE=my-tag BASE=ubuntu:24.04 bash test/isolation/build-image.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-agentshake-isolation:ubuntu24.04}
BASE=${BASE:-ubuntu:24.04}
docker build --build-arg "BASE=$BASE" -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
echo "built $IMAGE"
