# HermesAgent Faceplate — developer convenience targets.
#
# The Faceplate is a thin client: it connects to a HermesAgent (and an
# optional speech sidecar) by URL + key. It does not install, build, or
# supervise either of them. This Makefile only drives the Electron app's
# dev workflow.
#
# Backend services are set up with the standalone scripts under `setup/`,
# run on whatever host the service should live on:
#   setup/speech-sidecar.sh        — TTS / ASR / wake-word
#   setup/hermes-faceplate-plugin.sh — Hermes Pings (run on the Hermes host)
#   setup/hermes-event-hooks.sh    — event tap (run on the Hermes host)

SHELL   := /bin/bash
HERE    := $(shell pwd)
APP_DIR := $(HERE)/app

GREEN := \033[1;32m
RED   := \033[1;31m
RESET := \033[0m

.PHONY: help check-prereqs setup app typecheck build clean

help:            ## list targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "$(GREEN)%-15s$(RESET) %s\n", $$1, $$2}'

check-prereqs:   ## verify node + pnpm are installed
	@command -v node >/dev/null 2>&1 || { printf "$(RED)node not found$(RESET) — install Node 22+\n"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { printf "$(RED)pnpm not found$(RESET) — \`npm install -g pnpm\`\n"; exit 1; }
	@printf "$(GREEN)✓ prereqs ok$(RESET)\n"

setup: check-prereqs ## install app dependencies (one-time)
	@cd "$(APP_DIR)" && pnpm install
	@printf "$(GREEN)✓$(RESET) dependencies installed. Next: $(GREEN)make app$(RESET)\n"

app:             ## run the Faceplate Electron dev build
	@cd "$(APP_DIR)" && pnpm dev

typecheck:       ## type-check the app (vue-tsc)
	@cd "$(APP_DIR)" && pnpm typecheck

build:           ## production build of the Electron app
	@cd "$(APP_DIR)" && pnpm build

clean:           ## remove build artifacts
	@rm -rf "$(APP_DIR)/dist"
	@printf "$(GREEN)✓$(RESET) cleaned\n"
