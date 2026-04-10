export PORT ?= 8082
export PREVIEW_PORT ?= 4173

ifeq (,$(findstring n,$(MAKEFLAGS)))
RUN_HELP_COLORS := 1
else
RUN_HELP_COLORS := 0
endif

.PHONY: help bootstrap install dev build preview clean rebuild

help:
	@if [ "$(RUN_HELP_COLORS)" = "1" ]; then \
		bold="\033[1;4m"; green="\033[1;32m"; cyan="\033[36m"; reset="\033[0m"; \
	else \
		bold=""; green=""; cyan=""; reset=""; \
	fi; \
	printf "$${bold}Getting Started:$${reset}\n"; \
	grep -E '^[a-zA-Z0-9_-]+:.*## &start ' Makefile | while read -r line; do \
		printf "  $${green}%s$${reset}: %s\n" "$$(echo $$line | cut -d: -f1)" "$$(echo $$line | cut -d# -f3- | sed 's/^ \&start //')"; \
	done; \
	printf "\n$${bold}Build & Run:$${reset}\n"; \
	grep -E '^[a-zA-Z0-9_-]+:.*## &build ' Makefile | while read -r line; do \
		printf "  $${green}%s$${reset}: %s\n" "$$(echo $$line | cut -d: -f1)" "$$(echo $$line | cut -d# -f3- | sed 's/^ \&build //')"; \
	done; \
	printf "\n$${bold}Configuration:$${reset}\n"; \
	grep -E '^(export )?[A-Z0-9_]+ \?= ' Makefile | sort | while read -r line; do \
		name="$$(echo $$line | sed -E 's/^export //' | sed -E 's/ \?= .*$$//' | xargs)"; \
		value="$$(echo $$line | sed -E 's/^.*\?=//' | sed -E 's/^ +//' )"; \
		if [ -z "$$value" ]; then value=''; fi; \
		printf "  $${cyan}%s$${reset}=%s\n" "$$name" "$$value"; \
	done

bootstrap: install ## &start Bootstrap the project dependencies

install: ## &start Install npm dependencies
	npm install

dev: ## &build Start the local development server
	PORT=$(PORT) npm run dev

build: ## &build Create a production build in dist/
	npm run build

preview: ## &build Serve the built dashboard
	PORT=$(PREVIEW_PORT) npm run preview

clean: ## &build Remove generated artifacts and installed dependencies
	rm -rf dist node_modules

rebuild: clean install build ## &build Clean, reinstall, and rebuild from scratch