#!/usr/bin/env bash
set -euo pipefail

# Render build helper: install Foundry tools and compile the isolated-fork executor.
export PATH="${HOME}/.foundry/bin:${PATH}"

if ! command -v forge >/dev/null 2>&1 || ! command -v anvil >/dev/null 2>&1; then
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="${HOME}/.foundry/bin:${PATH}"
  foundryup
fi

forge --version
anvil --version
forge build
npm run build
