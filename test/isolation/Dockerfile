# Test image for the two-UID isolation harness (test/isolation/two-uid.sh).
# Official Node.js Linux builds from v26 link against libatomic.so.1. The base is the Docker
# Official Image buildpack-deps:noble (Ubuntu 24.04), which ships libatomic1, pinned by its
# multi-arch index digest. Nothing is downloaded during the build (no apt, which failed in CI when
# the Ubuntu archive mirrors were unreachable); the harness later runs with --network none.
ARG BASE=buildpack-deps@sha256:890e8b5c0040e1deff5cc7dc7b4414e67069f79e3301afc4ec5bd49d64ef13e5
FROM ${BASE}
RUN ldconfig -p | grep -q 'libatomic\.so\.1' \
 || { echo "The base image lacks libatomic.so.1, which Node.js 26 needs. Use an image that ships libatomic1." >&2; exit 1; }
