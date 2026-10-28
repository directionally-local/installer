#!/bin/sh
# Directionally Local: one-line server install.
#
#   curl -fsSL https://directionallylocal.run | sh
#
# Installs Node.js 24 if needed and the directionallylocal CLI (also `dl`), then runs
# `dl up`, which asks how to reach this server and for the model
# key, and sets up Hotcell + Autopilot as services. Safe to run again.
#
# Unattended: export DL_TAILSCALE_AUTH_KEY, DL_OPENROUTER_API_KEY and DL_GITHUB_TOKEN first.
# Install only (the laptop's setup, which then runs `dl up` itself over SSH): DL_INSTALL_ONLY=1.
# Pin a version: DL_VERSION=0.1.0. Install from a local tarball: DL_PACKAGE=/path/to.tgz.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf '\n  directionallylocal: %s\n' "$*" >&2; exit 1; }

# The same look as `dl up`: a running step has a spinner and a timer, and becomes "✓"
# when done. Without a terminal (or with NO_COLOR) it's plain lines.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  FANCY=1
else
  FANCY=""
fi
STEP=""
step() {
  STEP=$1
  if [ -n "$FANCY" ]; then printf '  \033[36m⠋\033[0m %s' "$1"; else say ".. $1"; fi
}
step_done() {
  if [ -n "$FANCY" ]; then printf '\r\033[2K  \033[32m✓\033[0m %-33s\033[2m%s\033[0m\n' "$1" "${2:-}"; else say "ok $1${2:+: $2}"; fi
}

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

# The spinner frame for tick $1 (POSIX sh has no arrays, and multibyte cut isn't portable).
frame() {
  case $(($1 % 10)) in
    0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;; 4) printf '⠼' ;;
    5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;; 8) printf '⠇' ;; *) printf '⠏' ;;
  esac
}

# On failure, show only this step's own output, not the earlier steps' in the same log.
show_step_log() {
  tail -n "+$(($1 + 1))" "$LOG" | tail -n 15 | while IFS= read -r line; do
    if [ -n "$FANCY" ]; then printf '    \033[2m%s\033[0m\n' "$line" >&2; else printf '    %s\n' "$line" >&2; fi
  done
}

quietly() {
  what=$1
  shift
  from=$(wc -l <"$LOG")
  if [ -z "$FANCY" ]; then
    "$@" >>"$LOG" 2>&1 || { show_step_log "$from"; fail "$what failed"; }
    return 0
  fi
  # Run in the background and animate the current step until it finishes.
  "$@" >>"$LOG" 2>&1 &
  pid=$!
  started=$(date +%s)
  tick=0
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$(($(date +%s) - started))
    printf '\r\033[2K  \033[36m%s\033[0m %-33s\033[2m%d:%02d\033[0m' "$(frame "$tick")" "$STEP" $((elapsed / 60)) $((elapsed % 60))
    tick=$((tick + 1))
    sleep 0.1
  done
  if ! wait "$pid"; then
    printf '\r\033[2K  \033[31m✗\033[0m %s\n\n' "$STEP"
    show_step_log "$from"
    fail "$what failed"
  fi
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

node_is_patched() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const fixed = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
    const ok = major > 26 || (fixed && (minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1])));
    process.exit(ok ? 0 : 1);
  ' 2>/dev/null
}

# Wrapped in a function so a truncated download never runs half a script.
main() {
  if [ -n "$FANCY" ]; then printf '\n  \033[1mDirectionally Local\033[0m\n\n'; else say "Directionally Local"; fi
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

  # Node must have the fix for CVE-2026-111497 (Brotli RCE via fetch): 22.23.4+, 24.22.1+ or
  # 26.12.1+, the same rule as Hotcell's engines. A missing or unsupported Node gets 24 LTS
  # (security fixes until April 2028); an unpatched 22, 24 or 26 is upgraded on its own line.
  if ! node_is_patched; then
    line=24
    case "$(node_major)" in 24|26) line=$(node_major) ;; esac
    step "Installing Node.js ${line}"
    quietly "adding the Node.js ${line} repository" as_root sh -c "curl -fsSL https://deb.nodesource.com/setup_${line}.x | bash -"
    quietly "installing Node.js ${line}" as_root apt-get install -y -qq nodejs
    node_is_patched || fail "Node.js $(node -v 2>/dev/null || echo '?') is still missing the CVE-2026-111497 fix; install 22.23.4+, 24.22.1+ or 26.12.1+ and re-run"
    step_done "Installed Node.js" "$(node -v)"
  fi

  package="${DL_PACKAGE:-directionallylocal@${DL_VERSION:-latest}}"
  step "Getting the installer"
  quietly "installing $package" as_root npm install -g --no-audit --no-fund --loglevel=error "$package"
  step_done "Got the installer" "dl $(dl --version 2>/dev/null || echo "")"

  # The laptop's setup stops here: it asks for the keys itself and runs `dl up` next,
  # with its own progress display.
  if [ "${DL_INSTALL_ONLY:-}" = "1" ]; then
    return 0
  fi

  # Prompts read the terminal, not this piped script. Test by opening it: the device
  # node exists even when there's no controlling terminal.
  # dl up continues the same screen, so it skips its own title.
  export DL_TITLE_SHOWN=1
  if (exec </dev/tty) 2>/dev/null; then
    as_root directionallylocal up </dev/tty
  else
    as_root directionallylocal up
  fi
}

main "$@"
