# Test image for the two-UID isolation harness (test/isolation/two-uid.sh).
# Official Node.js Linux builds from v26 link against libatomic.so.1, which the base
# ubuntu:24.04 image does not ship. This is the only addition; it is installed at build
# time (with network), and the harness itself later runs with --network none.
ARG BASE=ubuntu:24.04
FROM ${BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libatomic1 \
 && rm -rf /var/lib/apt/lists/*
