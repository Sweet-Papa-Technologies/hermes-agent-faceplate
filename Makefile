# HermesAgent Faceplate — top-level convenience targets.
#
# `make help` lists everything. The Makefile only manages the Faceplate's
# own pieces (sidecar Docker container, Electron app dev workflow). The
# hermes-agent container is your own — see SETUP.md for the docker run
# incantation if you need it.

SHELL          := /bin/bash
HERE           := $(shell pwd)
SIDECAR_DIR    := $(HERE)/sidecar
APP_DIR        := $(HERE)/app

# `cpu` | `cpu-slim` | `cuda`. Inline `# comments` after a Make assignment
# get included in the variable value as trailing whitespace, so keep this
# on a clean line of its own.
SIDECAR_VARIANT ?= cpu
COMPOSE_FILE    := $(SIDECAR_DIR)/compose.$(SIDECAR_VARIANT).yml
CONFIG_FILE     := $(SIDECAR_DIR)/config.yaml
EXAMPLE_CONFIG  := $(SIDECAR_DIR)/config.example.yaml
KEY_CACHE       := $(SIDECAR_DIR)/.faceplate-api-key

HERMES_URL      ?= http://127.0.0.1:8642
HERMES_KEY      ?=
SIDECAR_URL     ?= http://127.0.0.1:8080

GREEN  := \033[1;32m
YELLOW := \033[1;33m
RED    := \033[1;31m
RESET  := \033[0m

.PHONY: help setup up down restart logs verify app clean check-prereqs \
        hermes-up hermes-down hermes-logs hermes-agent-log hermes-errors hermes-last-run \
        hermes-configure-tools \
        litert-up litert-down litert-logs litert-status \
        llm-tunnel-up llm-tunnel-down llm-tunnel-status llm-tunnel-logs \
        searxng-up searxng-down searxng-logs searxng-status \
        all

help:                ## list targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "$(GREEN)%-15s$(RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables you can override:"
	@echo "  SIDECAR_VARIANT=cpu|cpu-slim|cuda   (default: cpu)"
	@echo "  HERMES_URL=...                       (default: http://127.0.0.1:8642)"
	@echo "  HERMES_KEY=...                       (default: read from ~/.hermes/.env)"

check-prereqs:       ## verify docker, pnpm, node are installed
	@command -v docker >/dev/null 2>&1 || { printf "$(RED)docker not found$(RESET) — install Docker Desktop or podman\n"; exit 1; }
	@docker compose version >/dev/null 2>&1 || { printf "$(RED)docker compose plugin not found$(RESET)\n"; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { printf "$(RED)pnpm not found$(RESET) — \`npm install -g pnpm\`\n"; exit 1; }
	@command -v node >/dev/null 2>&1 || { printf "$(RED)node not found$(RESET)\n"; exit 1; }
	@printf "$(GREEN)✓ prereqs ok$(RESET)\n"

setup: check-prereqs ## one-time bootstrap: configs + tokens + dependencies
	@echo "─── Setting up Faceplate sidecar ───"
	@if [ ! -f "$(CONFIG_FILE)" ]; then \
		cp "$(EXAMPLE_CONFIG)" "$(CONFIG_FILE)"; \
		printf "$(GREEN)✓$(RESET) wrote $(CONFIG_FILE) (from example)\n"; \
	else \
		printf "$(YELLOW)·$(RESET) $(CONFIG_FILE) already exists — leaving alone\n"; \
	fi
	@if [ ! -f "$(KEY_CACHE)" ]; then \
		openssl rand -hex 32 > "$(KEY_CACHE)"; \
		chmod 600 "$(KEY_CACHE)"; \
		printf "$(GREEN)✓$(RESET) generated FACEPLATE_API_KEY → $(KEY_CACHE)\n"; \
	else \
		printf "$(YELLOW)·$(RESET) FACEPLATE_API_KEY already cached — reusing\n"; \
	fi
	@echo "─── Installing app dependencies ───"
	@cd "$(APP_DIR)" && pnpm install --silent
	@printf "$(GREEN)✓$(RESET) pnpm install complete\n"
	@echo ""
	@printf "$(GREEN)Setup done.$(RESET) Next:\n"
	@printf "  1. $(YELLOW)make up$(RESET)     — start the sidecar container (~4 GB CPU image; ~1 min cold start)\n"
	@printf "  2. $(YELLOW)make app$(RESET)    — launch the Faceplate Electron app\n"
	@printf "  3. Walk the wizard. Sidecar token to paste in Settings → Speech Sidecar:\n"
	@printf "     $(GREEN)$$(cat $(KEY_CACHE))$(RESET)\n"

up:                  ## start the sidecar (Docker)
	@if [ ! -f "$(KEY_CACHE)" ]; then \
		printf "$(RED)Run \`make setup\` first.$(RESET)\n"; exit 1; \
	fi
	@FACEPLATE_API_KEY="$$(cat $(KEY_CACHE))" \
		docker compose -f "$(COMPOSE_FILE)" up -d --build
	@printf "$(GREEN)✓$(RESET) sidecar starting in background. Tail logs with \`make logs\`.\n"

down:                ## stop the sidecar
	@docker compose -f "$(COMPOSE_FILE)" down
	@printf "$(GREEN)✓$(RESET) sidecar stopped\n"

restart: down up     ## bounce the sidecar

logs:                ## tail sidecar logs (Ctrl+C to detach)
	@docker compose -f "$(COMPOSE_FILE)" logs -f sidecar

app:                 ## run the Faceplate Electron dev build
	@cd "$(APP_DIR)" && pnpm dev

verify:              ## health-check hermes + the sidecar
	@printf "─── hermes-agent ($(HERMES_URL)) ───\n"
	@if [ -z "$(HERMES_KEY)" ] && [ -r ~/.hermes/.env ]; then \
		key=$$(grep -E '^API_SERVER_KEY=' ~/.hermes/.env | cut -d= -f2- | tr -d '"' | tr -d "'"); \
	else \
		key="$(HERMES_KEY)"; \
	fi; \
	if curl -fsS -H "Authorization: Bearer $$key" "$(HERMES_URL)/v1/health" >/dev/null; then \
		printf "$(GREEN)✓$(RESET) hermes /v1/health 200\n"; \
	else \
		printf "$(RED)✗$(RESET) hermes /v1/health unreachable. Is the container up with -p 127.0.0.1:8642:8642 and API_SERVER_HOST=0.0.0.0?\n"; \
	fi
	@printf "─── faceplate-sidecar ($(SIDECAR_URL)) ───\n"
	@key="$$(cat $(KEY_CACHE) 2>/dev/null || echo '')"; \
	if curl -fsS -H "Authorization: Bearer $$key" "$(SIDECAR_URL)/health" >/dev/null; then \
		printf "$(GREEN)✓$(RESET) sidecar /health 200\n"; \
		curl -sS -H "Authorization: Bearer $$key" "$(SIDECAR_URL)/health" | head -c 600; echo; \
	else \
		printf "$(RED)✗$(RESET) sidecar /health unreachable. Try \`make up\` then \`make logs\`.\n"; \
	fi
	@printf "─── litert-lm (http://127.0.0.1:7860) ───\n"
	@if (echo > /dev/tcp/127.0.0.1/7860) >/dev/null 2>&1; then \
		printf "$(GREEN)✓$(RESET) litert-lm port 7860 open\n"; \
	else \
		printf "$(RED)✗$(RESET) litert-lm not listening. Try \`make litert-up\`.\n"; \
	fi

clean:               ## stop sidecar + drop its volumes (models cache included)
	@read -p "This deletes sidecar volumes (models, voices, wakewords). Continue? [y/N] " yn; \
		[ "$$yn" = "y" ] || { echo "aborted"; exit 0; }
	@docker compose -f "$(COMPOSE_FILE)" down -v
	@printf "$(GREEN)✓$(RESET) volumes removed\n"

hermes-up:           ## start hermes-agent in Docker (idempotent — recreates on re-run)
	@bash $(HERE)/scripts/start-hermes.sh

hermes-down:         ## stop the hermes-agent container (volume preserved)
	@docker rm -f hermes-personal 2>/dev/null && \
		printf "$(GREEN)✓$(RESET) hermes-personal stopped\n" || \
		printf "$(YELLOW)·$(RESET) hermes-personal wasn't running\n"

hermes-logs:         ## tail container stdout (gateway banner only — most activity is in agent.log)
	@docker logs -f hermes-personal

hermes-agent-log:    ## tail ~/.hermes/logs/agent.log (HTTP access + agent-loop info)
	@if [ -f $(HOME)/.hermes/logs/agent.log ]; then \
		tail -f $(HOME)/.hermes/logs/agent.log; \
	else \
		printf "$(YELLOW)·$(RESET) no agent.log yet — make a request first\n"; \
	fi

hermes-errors:       ## tail ~/.hermes/logs/errors.log (LLM call failures, retries)
	@if [ -f $(HOME)/.hermes/logs/errors.log ]; then \
		tail -f $(HOME)/.hermes/logs/errors.log; \
	else \
		printf "$(YELLOW)·$(RESET) no errors.log yet\n"; \
	fi

hermes-last-run:     ## dump the most recent run's messages + tool calls (one-shot)
	@python3 $(HERE)/scripts/dump-last-run.py

# ─── litert-lm (host-native LLM for paraphrase) ─────────────────────────

LITERT_PID := $(HOME)/.faceplate/litert.pid
LITERT_LOG := $(HOME)/.faceplate/litert.log

litert-up:           ## start the host-native litert-lm OpenAI server (port 7860)
	@bash $(HERE)/scripts/start-litert.sh

litert-down:         ## stop the litert-lm server
	@if [ -f "$(LITERT_PID)" ]; then \
		pid=$$(cat "$(LITERT_PID)"); \
		if kill -0 $$pid 2>/dev/null; then \
			kill $$pid && printf "$(GREEN)✓$(RESET) litert-lm (pid $$pid) stopped\n"; \
		fi; \
		rm -f "$(LITERT_PID)"; \
	else \
		printf "$(YELLOW)·$(RESET) litert-lm wasn't running\n"; \
	fi

litert-logs:         ## tail litert-lm log
	@if [ -f "$(LITERT_LOG)" ]; then tail -f "$(LITERT_LOG)"; else \
		printf "$(YELLOW)·$(RESET) no log yet — run \`make litert-up\` first\n"; fi

litert-status:       ## show litert-lm status
	@if [ -f "$(LITERT_PID)" ] && kill -0 $$(cat $(LITERT_PID)) 2>/dev/null; then \
		printf "$(GREEN)✓$(RESET) litert-lm running (pid $$(cat $(LITERT_PID)))\n"; \
	else \
		printf "$(RED)✗$(RESET) litert-lm not running\n"; \
	fi

# ─── llm-tunnel (host-side socat for Docker → LAN LLM) ──────────────────

LLM_TUNNEL_PID := $(HOME)/.faceplate/llm-tunnel.pid
LLM_TUNNEL_LOG := $(HOME)/.faceplate/llm-tunnel.log

llm-tunnel-up:       ## tunnel a LAN LLM into the hermes Docker container (idempotent)
	@bash $(HERE)/scripts/start-llm-tunnel.sh

llm-tunnel-down:     ## stop the socat tunnel
	@if [ -f "$(LLM_TUNNEL_PID)" ]; then \
		pid=$$(cat "$(LLM_TUNNEL_PID)"); \
		if kill -0 $$pid 2>/dev/null; then \
			kill $$pid && printf "$(GREEN)✓$(RESET) socat tunnel (pid $$pid) stopped\n"; \
		fi; \
		rm -f "$(LLM_TUNNEL_PID)"; \
	else \
		printf "$(YELLOW)·$(RESET) llm tunnel wasn't running\n"; \
	fi

llm-tunnel-status:   ## show llm-tunnel status
	@if [ -f "$(LLM_TUNNEL_PID)" ] && kill -0 $$(cat $(LLM_TUNNEL_PID)) 2>/dev/null; then \
		printf "$(GREEN)✓$(RESET) llm-tunnel running (pid $$(cat $(LLM_TUNNEL_PID)))\n"; \
	else \
		printf "$(RED)✗$(RESET) llm-tunnel not running\n"; \
	fi

llm-tunnel-logs:     ## tail llm-tunnel log
	@if [ -f "$(LLM_TUNNEL_LOG)" ]; then tail -f "$(LLM_TUNNEL_LOG)"; else \
		printf "$(YELLOW)·$(RESET) no log yet — run \`make llm-tunnel-up\` first\n"; fi

# ─── searxng (free local web search backend for hermes) ─────────────────

SEARXNG_COMPOSE := $(HERE)/searxng/docker-compose.yml

searxng-up:          ## start SearXNG on 127.0.0.1:9080 + configure hermes to use it
	@bash $(HERE)/scripts/start-searxng.sh

searxng-down:        ## stop SearXNG (volumes preserved)
	@docker compose -f $(SEARXNG_COMPOSE) down 2>/dev/null && \
		printf "$(GREEN)✓$(RESET) searxng stopped\n" || \
		printf "$(YELLOW)·$(RESET) searxng wasn't running\n"

searxng-logs:        ## tail searxng container logs
	@docker compose -f $(SEARXNG_COMPOSE) logs -f searxng

searxng-status:      ## show searxng status
	@if docker ps --format '{{.Names}}' | grep -qx searxng; then \
		printf "$(GREEN)✓$(RESET) searxng running on http://127.0.0.1:9080\n"; \
	else \
		printf "$(RED)✗$(RESET) searxng not running\n"; \
	fi

hermes-configure-tools: ## (re)patch ~/.hermes/config.yaml + .env for web + browser toolsets
	@python3 $(HERE)/scripts/configure-hermes-tools.py

all: hermes-up litert-up setup up ## bring everything up except the Electron app (then run `make app`)
	@printf "\n$(GREEN)Everything is running.$(RESET) Now: $(YELLOW)make app$(RESET)\n"
