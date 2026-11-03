#!/bin/sh
# Directionally Local: one-line install, for a laptop or a server.
#
#   curl -fsSL https://directionallylocal.run | sh
#
# On a laptop (macOS or Linux, as yourself): installs dl into ~/.directionallylocal with no
# sudo, and Node.js there too when this one is missing or too old, puts dl on your PATH for
# new shells, and starts dl in the folder you ran it from. Nothing else is set up until you
# ask for background tasks (dl run, dl setup).
#
# On a server (Linux as root, or `| sudo sh`): installs Node.js 24 if needed and the
# directionallylocal CLI (also `dl`), then runs `dl up`, which asks how to reach this server
# and for the model key, and sets up Hotcell + Autopilot as services. Safe to run again.
#
# Which one: DL_MODE=server or DL_MODE=laptop decides. Otherwise it's a server when the
# laptop's setup runs it (DL_INSTALL_ONLY=1), when it runs as root on Linux, or when dl up
# already set this Linux machine up as a server; anything else is a laptop. That's the same
# line `dl` itself draws: on a machine without a server install, root gets the server's
# instructions and everyone else the laptop's.
#
# Unattended server: export DL_TAILSCALE_AUTH_KEY, DL_PROVIDER + DL_PROVIDER_API_KEY (or DL_OPENROUTER_API_KEY)
# and DL_GITHUB_TOKEN first.
# Install only (the laptop's setup, which then runs `dl up` itself over SSH): DL_INSTALL_ONLY=1.
# Pin a version: DL_VERSION=0.1.0. Install from a local tarball: DL_PACKAGE=/path/to.tgz.
# Laptop: DL_HOME=DIR installs somewhere else; DL_NO_START=1 doesn't start dl at the end;
# DL_NO_MODIFY_PATH=1 leaves your shell's startup file alone.
set -eu

DL_HOME="${DL_HOME:-${HOME:-}/.directionallylocal}"

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
  if [ -n "$FANCY" ]; then printf '\r\033[2K  \033[32m✓\033[0m %-33s\033[2m%s\033[0m\n' "$1" "${2:-}"; else say "ok ${STEP:-$1}${2:+: $2}"; fi
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

# Whether a Node ($1, else the one on PATH) has the fix: the same floor as dl's engines.
node_is_patched() {
  command -v "${1:-node}" >/dev/null 2>&1 || return 1
  "${1:-node}" -e '
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const fixed = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
    const ok = major > 26 || (fixed && (minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1])));
    process.exit(ok ? 0 : 1);
  ' 2>/dev/null
}

# Server or laptop (see the top of this file). DL_SERVER_STATE stands in for dl up's state file in tests.
install_mode() {
  if [ -n "${DL_MODE:-}" ]; then
    echo "$DL_MODE"
  elif [ "${DL_INSTALL_ONLY:-}" = "1" ]; then
    echo server
  elif [ "$(uname -s)" != "Linux" ]; then
    echo laptop
  elif [ "$(id -u)" -eq 0 ] || [ -e "${DL_SERVER_STATE:-/etc/directionallylocal/state.json}" ]; then
    echo server
  else
    echo laptop
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Node.js 24 LTS from nodejs.org into $DL_HOME, checked against its published SHA-256.
install_own_node() {
  base="${DL_NODE_DIST:-https://nodejs.org/dist/latest-v24.x}"
  step "Installing Node.js 24"
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || fail "couldn't reach nodejs.org to download Node.js"
  want="-$1-$2.tar.gz"
  file=$(printf '%s\n' "$sums" | awk -v want="$want" 'substr($2, length($2) - length(want) + 1) == want { print $2; exit }')
  expected=$(printf '%s\n' "$sums" | awk -v file="$file" '$2 == file { print $1; exit }')
  [ -n "$file" ] && [ -n "$expected" ] || fail "nodejs.org has no Node.js 24 for $1-$2"
  download="$DL_HOME/$file.download"
  quietly "downloading $file" curl -fsSL "$base/$file" -o "$download"
  if [ "$(sha256_of "$download")" != "$expected" ]; then
    rm -f "$download"
    fail "the Node.js download didn't match its checksum; try again"
  fi
  dir="${file%.tar.gz}"
  rm -rf "${DL_HOME:?}/$dir"
  quietly "unpacking Node.js" tar -xzf "$download" -C "$DL_HOME"
  rm -f "$download"
  ln -sfn "$DL_HOME/$dir" "$DL_HOME/node"
  # Earlier downloads, now that the link points at this one.
  for old in "$DL_HOME"/node-v*; do
    if [ -d "$old" ] && [ "$old" != "$DL_HOME/$dir" ]; then rm -rf "$old"; fi
  done
  node_is_patched "$DL_HOME/node/bin/node" || fail "the Node.js from nodejs.org ($("$DL_HOME/node/bin/node" -v 2>/dev/null || echo '?')) is missing the CVE-2026-111497 fix"
  step_done "Installed Node.js" "$("$DL_HOME/node/bin/node" -v) · in $DL_HOME/node"
}

# The line that puts $DL_HOME/bin on PATH, in the startup file of the user's shell.
add_to_path() {
  case $(basename "${SHELL:-sh}") in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$1" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    fish) rc="$HOME/.config/fish/conf.d/directionallylocal.fish" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -f "$rc" ] && grep -qF "$DL_HOME/bin" "$rc"; then
    return 0
  fi
  step "Adding dl to your PATH"
  mkdir -p "$(dirname "$rc")"
  # The $PATH in these lines is for the shell to expand when it starts, not now.
  # shellcheck disable=SC2016
  case $rc in
    *.fish) printf '\n# Directionally Local (dl)\nset -gx PATH "%s" $PATH\n' "$DL_HOME/bin" >>"$rc" ;;
    *) printf '\n# Directionally Local (dl)\nexport PATH="%s:$PATH"\n' "$DL_HOME/bin" >>"$rc" ;;
  esac
  step_done "Added dl to your PATH" "in $rc"
}

# A laptop: everything under $DL_HOME, as this user; no sudo, no services.
laptop_main() {
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "this works on macOS and Linux (found $(uname -s)); on Windows, run it inside WSL 2" ;;
  esac
  case $(uname -m) in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail "Node.js has no build for this CPU ($(uname -m))" ;;
  esac
  [ "$(id -u)" -ne 0 ] || fail "on a laptop, run it as yourself, without sudo: it installs into your home directory"
  [ -n "${HOME:-}" ] || [ "$DL_HOME" != "/.directionallylocal" ] || fail "HOME isn't set; set it, or DL_HOME=DIR"
  command -v curl >/dev/null 2>&1 || fail "curl is needed"
  mkdir -p "$DL_HOME/bin"
  chmod 700 "$DL_HOME"

  # A Node that's new enough is used where it is; otherwise dl gets its own, which goes on
  # PATH only for dl and what it starts (Autopilot, npm), not for your shell.
  own=""
  if node_is_patched; then
    node=$(command -v node)
  else
    if ! node_is_patched "$DL_HOME/node/bin/node"; then
      install_own_node "$os" "$arch"
    fi
    node="$DL_HOME/node/bin/node"
    own=1
  fi
  node_dir=$(dirname "$node")
  npm="$node_dir/npm"
  [ -x "$npm" ] || npm=npm

  package="${DL_PACKAGE:-directionallylocal@${DL_VERSION:-latest}}"
  step "Installing dl"
  quietly "installing $package" env PATH="$node_dir:$PATH" "$npm" install -g --prefix "$DL_HOME/dl" --no-audit --no-fund --loglevel=error "$package"
  entry="$DL_HOME/dl/lib/node_modules/directionallylocal/bin/directionallylocal.mjs"
  [ -f "$entry" ] || fail "npm installed $package, but $entry is missing"
  # $PATH and $@ in the wrappers are theirs to expand when dl runs.
  # shellcheck disable=SC2016
  for name in dl directionallylocal; do
    if [ -n "$own" ]; then
      printf '#!/bin/sh\n# Written by the Directionally Local install script.\nexport PATH="%s:$PATH"\nexec "%s" "%s" "$@"\n' "$node_dir" "$node" "$entry" >"$DL_HOME/bin/$name"
    else
      printf '#!/bin/sh\n# Written by the Directionally Local install script.\nexec "%s" "%s" "$@"\n' "$node" "$entry" >"$DL_HOME/bin/$name"
    fi
    chmod 755 "$DL_HOME/bin/$name"
  done
  step_done "Installed dl" "dl $("$DL_HOME/bin/dl" --version 2>/dev/null || echo "") · in $DL_HOME"

  if [ "${DL_NO_MODIFY_PATH:-}" != "1" ]; then
    add_to_path "$os"
  fi
  if [ "$os" = linux ]; then
    say "  For a server instead, run it as root: curl -fsSL https://directionallylocal.run | sudo sh"
  fi
  case ":$PATH:" in
    *":$DL_HOME/bin:"*) ;;
    *) say "  Open a new terminal tab if dl isn't found." ;;
  esac

  # Interactive: go straight into dl in this folder (plain Autopilot the first time).
  # (DL_TTY stands in for the terminal in tests.)
  tty="${DL_TTY:-/dev/tty}"
  if [ "${DL_NO_START:-}" != "1" ] && (exec <"$tty") 2>/dev/null; then
    say ""
    "$DL_HOME/bin/dl" <"$tty"
    return
  fi
  say "  Then type: dl"
}

# Wrapped in a function so a truncated download never runs half a script.
main() {
  if [ -n "$FANCY" ]; then printf '\n  \033[1mDirectionally Local\033[0m\n\n'; else say "Directionally Local"; fi
  case "${DL_MODE:-}" in
    ""|server|laptop) ;;
    *) fail "DL_MODE is server or laptop (got ${DL_MODE})" ;;
  esac
  if [ "$(install_mode)" = laptop ]; then
    laptop_main
    return
  fi

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
