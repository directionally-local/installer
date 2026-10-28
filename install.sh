#!/bin/sh
# Directionally Local: one-line server install.
#
#   curl -fsSL https://directionallylocal.run | sh
#
# Installs Node.js 22 if needed and the directionally-local CLI (also `dl`), then runs
# `dl up`, which asks how to reach this server and for the model
# key, and sets up Hotcell + Autopilot as services. Safe to run again.
#
# Unattended: export DL_TAILSCALE_AUTH_KEY, DL_OPENROUTER_API_KEY and DL_GITHUB_TOKEN first.
# Pin a version: DL_VERSION=0.1.0. Install from a local tarball: DL_PACKAGE=/path/to.tgz.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'directionally-local: %s\n' "$*" >&2; exit 1; }

# Quiet steps: output goes to a log that's shown only if the step fails.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
# Runs a command as root, through sudo when needed (keeping DL_* answers in the environment).
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -E "$@"
  fi
}

quietly() {
  what=$1
  shift
  if ! "$@" >>"$LOG" 2>&1; then
    tail -n 20 "$LOG" >&2
    fail "$what failed"
  fi
}

# Wrapped in a function so a truncated download never runs half a script.
main() {
  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    fail "run as root (or install sudo)"
  fi

  [ "$(uname -s)" = "Linux" ] || fail "only Linux servers are supported (found $(uname -s))"
  [ -r /etc/os-release ] || fail "can't identify this Linux distribution (/etc/os-release missing)"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) fail "${PRETTY_NAME:-this distribution} isn't supported yet; use Ubuntu 24.04 or 22.04, or Debian 12" ;;
  esac
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v curl >/dev/null 2>&1; then
    quietly "apt-get update" as_root apt-get update -qq
    quietly "installing curl" as_root apt-get install -y -qq curl ca-certificates
  fi

  node_major=0
  if command -v node >/dev/null 2>&1; then
    node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  fi
  if [ "$node_major" -lt 22 ]; then
    say "Installing Node.js 22..."
    quietly "adding the Node.js 22 repository" as_root sh -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
    quietly "installing Node.js 22" as_root apt-get install -y -qq nodejs
  fi

  package="${DL_PACKAGE:-directionally-local@${DL_VERSION:-latest}}"
  say "Installing ${package}..."
  quietly "installing $package" as_root npm install -g --no-audit --no-fund --loglevel=error "$package"

  # Prompts read the terminal, not this piped script. Test by opening it: the device
  # node exists even when there's no controlling terminal.
  if (exec </dev/tty) 2>/dev/null; then
    as_root directionally-local up </dev/tty
  else
    as_root directionally-local up
  fi
}

main "$@"
