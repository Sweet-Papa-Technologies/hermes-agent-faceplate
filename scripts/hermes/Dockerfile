# HermesAgent + browser tooling, baked in.
#
# The upstream `nousresearch/hermes-agent` image ships the agent + the
# `browser` toolset wiring + Playwright's headless Chromium binary, but it
# does NOT include the runtime entrypoints Hermes' tools actually invoke:
#
#   - `agent-browser` (npm CLI that wraps Playwright; what `browser_navigate`
#     etc. actually shells out to)
#   - a Chromium binary the CLI can drive (Chrome-for-Testing has no ARM64
#     Linux build, so `agent-browser install` fails on Apple-Silicon hosts)
#
# We add both here so the container is browser-ready out of the box and
# survives `docker rm` / `compose up --force-recreate` (the bind-mounted
# /opt/data volume preserves data, but anything in image layers — npm
# globals, apt packages — needs to be in the image).
#
# Built by scripts/start-hermes.sh as `hermes-faceplate:browser`. Not published.

ARG HERMES_BASE=nousresearch/hermes-agent:latest
FROM ${HERMES_BASE}

USER root

# Chromium provides ARM64 Linux builds (Chrome-for-Testing does not).
# Using the same package across architectures keeps the image consistent
# and avoids a per-arch branch. ~200 MB of dependencies, cached as one
# layer so repeat builds are instant.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/*

# agent-browser CLI lives in the npm global prefix (/usr/local). One layer,
# also cached unless the base image's node version changes.
RUN npm install -g agent-browser

# Tell Hermes' browser_tool which executable to drive — without this the
# CLI looks in its own ~/.cache/agent-browser/browsers (empty by default)
# and complains "Chrome not found".
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Leave entrypoint alone — the base image's tini → /opt/hermes/docker/entrypoint.sh
# already drops privileges to the `hermes` user before launching the gateway.
