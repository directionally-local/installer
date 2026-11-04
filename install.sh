#!/bin/sh
# Directionally Local: one-line install, for a laptop or a server.
#
#   curl -fsSL https://directionallylocal.run | sh
#
# On a laptop (macOS or Linux, as yourself): installs dl into ~/.directionallylocal with no
# sudo, and Node.js there too when this one is missing or too old, puts dl on your PATH for
# new shells (and links it into ~/.local/bin or ~/bin when one is already on this shell's
# PATH, so dl works in this terminal too), and starts dl in the folder you ran it from.
# Nothing else is set up until you ask for background tasks (dl run, dl setup).
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
# Invite links (curl -fsSL https://dl.new/r/CODE | sh) set DL_REFERRAL=CODE, a GitHub login:
# it's passed on to dl, which passes it to Autopilot for the free tier sign-in. On a laptop it's
# also kept in ~/.config/directionallylocal/pending-referral until that sign-in, so signing in on
# a later run still credits it.
# At the end it sends one anonymous count to free.directionallylocal.com (OS, chip, laptop or server, dl version, ok or the step that failed, which page); no IP or identity is kept, and DL_NO_TELEMETRY=1, DO_NOT_TRACK=1 or CI turns it off.
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
# How long the last quiet step took, in seconds.
STEP_SECONDS=0
# NPM_CACHE: the laptop install's own npm cache, removed when it's done (see laptop_main).
NPM_CACHE=""
# On the way out: clean up, and count a failed install when it ends with an error (fail, or a
# command under set -e). The script's exit code stays what it was.
on_exit() {
  exit_code=$?
  rm -f "$LOG"
  if [ -n "$NPM_CACHE" ]; then rm -rf "$NPM_CACHE"; fi
  if [ "$exit_code" -ne 0 ]; then count_install failed; fi
}
trap on_exit EXIT

# The anonymous count at the end: the step the install is on (one of preflight, node,
# install_dl, path, dl_up), laptop or server, and dl's version once it's installed.
STAGE=preflight
COUNT_MODE=""
COUNT_VERSION=""
COUNTED=""

# Sends the one count, in the background: never waits, prints nothing, never fails the install.
# Off with DL_NO_TELEMETRY=1, DO_NOT_TRACK=1, or in CI. Every value is from a fixed list.
count_install() {
  if [ -n "$COUNTED" ] || [ -z "$COUNT_MODE" ]; then return 0; fi
  COUNTED=1
  case "${DL_NO_TELEMETRY:-}" in ""|0|false) ;; *) return 0 ;; esac
  case "${DO_NOT_TRACK:-}" in ""|0|false) ;; *) return 0 ;; esac
  if [ -n "${CI:-}" ]; then return 0; fi
  command -v curl >/dev/null 2>&1 || return 0
  case $(uname -s 2>/dev/null) in Darwin) c_os=darwin ;; Linux) c_os=linux ;; *) return 0 ;; esac
  case $(uname -m 2>/dev/null) in arm64|aarch64) c_arch=arm64 ;; x86_64|amd64) c_arch=x64 ;; *) return 0 ;; esac
  case "${DL_INSTALL_VIA:-}" in home|invite|continue) c_via=$DL_INSTALL_VIA ;; *) c_via=run ;; esac
  c_version=""
  case $COUNT_VERSION in
    *[!0-9.]*) ;;
    [0-9]*.[0-9]*.[0-9]*) c_version=$COUNT_VERSION ;;
  esac
  c_body=$(printf '{"os":"%s","arch":"%s","mode":"%s","dlVersion":"%s","result":"%s",' "$c_os" "$c_arch" "$COUNT_MODE" "$c_version" "$1")
  if [ "$1" = failed ]; then c_body="$c_body\"failedStep\":\"$STAGE\","; fi
  c_body="$c_body\"via\":\"$c_via\"}"
  (curl -fsS -m 3 -X POST -H 'Content-Type: application/json' -d "$c_body" https://free.directionallylocal.com/v1/telemetry/install >/dev/null 2>&1 &) 2>/dev/null || true
}
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
  # Without npm's progress lines (http, info, timing): the error is in what's left.
  tail -n "+$(($1 + 1))" "$LOG" | grep -v '^npm \(http\|info\|timing\) ' | tail -n 15 | while IFS= read -r line; do
    if [ -n "$FANCY" ]; then printf '    \033[2m%s\033[0m\n' "$line" >&2; else printf '    %s\n' "$line" >&2; fi
  done
}

# A step's live progress: when WATCH names a function, quietly calls it about once a second
# with the log line the step's output starts after. It sets LABEL (what's happening now, in
# place of the step's name), DETAIL (how far along) and SLOW_MB (the download's size, for the
# slow-network hint; empty once the download is done). WATCH is cleared when the step ends.
WATCH=""
LABEL=""
DETAIL=""
SLOW_MB=""

# m:ss
clock() {
  printf '%d:%02d' $(($1 / 60)) $(($1 % 60))
}

# A line under the running step, once: it scrolls up with the steps and stays readable.
hint() {
  if [ -n "$FANCY" ]; then printf '\r\033[2K    \033[33m%s\033[0m\n' "$*"; else say "   $*"; fi
}

quietly() {
  what=$1
  shift
  from=$(wc -l <"$LOG")
  if [ -z "$FANCY" ] && [ -z "$WATCH" ]; then
    "$@" >>"$LOG" 2>&1 || { show_step_log "$from"; fail "$what failed"; }
    return 0
  fi
  # Run in the background and show the current step until it finishes: animated at a
  # terminal; otherwise a plain line when the step moves on, and its progress every 15 s.
  "$@" >>"$LOG" 2>&1 &
  pid=$!
  started=$(date +%s)
  tick=0
  LABEL=$STEP
  DETAIL=""
  SLOW_MB=""
  hinted=""
  printed="$STEP"
  printed_at=0
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$(($(date +%s) - started))
    if [ -n "$WATCH" ] && [ $((tick % 10)) -eq 0 ]; then
      "$WATCH" "$from"
      # After 90 s still downloading: probably a slow connection, so say what to expect.
      # (DL_SLOW_AFTER shortens the wait in tests.)
      if [ -z "$hinted" ] && [ -n "$SLOW_MB" ] && [ "$elapsed" -ge "${DL_SLOW_AFTER:-90}" ]; then
        hinted=1
        hint "Slow network? This downloads about $SLOW_MB MB. It keeps going; press Ctrl+C to stop."
      fi
    fi
    if [ -n "$FANCY" ]; then
      printf '\r\033[2K  \033[36m%s\033[0m %-33s\033[2m%s%s\033[0m' "$(frame "$tick")" "$LABEL" "${DETAIL:+$DETAIL · }" "$(clock "$elapsed")"
    elif [ "$LABEL" != "$printed" ] || { [ -n "$DETAIL" ] && [ $((elapsed - printed_at)) -ge 15 ]; }; then
      say "   $LABEL${DETAIL:+: $DETAIL} ($(clock "$elapsed"))"
      printed=$LABEL
      printed_at=$elapsed
    fi
    tick=$((tick + 1))
    sleep 0.1
  done
  WATCH=""
  if ! wait "$pid"; then
    if [ -n "$FANCY" ]; then printf '\r\033[2K  \033[31m✗\033[0m %s\n\n' "$LABEL"; fi
    show_step_log "$from"
    fail "$what failed"
  fi
  STEP_SECONDS=$(($(date +%s) - started))
}

# The size of a file in bytes, 0 while it doesn't exist.
file_bytes() {
  if [ -f "$1" ]; then wc -c <"$1" | tr -d ' '; else echo 0; fi
}

# Megabytes, for people: 37 (rounded; at least 1).
mb() {
  echo $((($1 + 999999) / 1000000))
}

# The size a URL will download, from its Content-Length (after redirects); empty when unknown.
remote_bytes() {
  curl -fsSIL "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { if (n > 0) print n }'
}

# WATCH for a curl download (DOWNLOAD_TO, DOWNLOAD_BYTES): "45% · 14 of 31 MB".
watch_download() {
  got=$(file_bytes "$DOWNLOAD_TO")
  if [ -n "$DOWNLOAD_BYTES" ] && [ "$DOWNLOAD_BYTES" -gt 0 ]; then
    DETAIL="$((got * 100 / DOWNLOAD_BYTES))% · $((got / 1000000)) of $(mb "$DOWNLOAD_BYTES") MB"
    SLOW_MB=$(mb "$DOWNLOAD_BYTES")
  else
    DETAIL="$((got / 1000000)) MB so far"
  fi
}

# Downloads URL $1 to $2 as step $3 (the label shown while it runs), with its progress.
download() {
  DOWNLOAD_TO=$2
  DOWNLOAD_BYTES=$(remote_bytes "$1") || DOWNLOAD_BYTES=""
  STEP="$3${DOWNLOAD_BYTES:+ ($(mb "$DOWNLOAD_BYTES") MB)}"
  if [ -n "$FANCY" ]; then printf '\r\033[2K'; fi
  step "$STEP"
  WATCH=watch_download
  quietly "downloading $1" curl -fsSL "$1" -o "$2"
}

# About how much the npm install downloads (dl, Autopilot and their packages), for the
# slow-network hint; npm doesn't say in advance.
NPM_DOWNLOAD_MB=40

# WATCH for `npm install --loglevel=info`: which phase it's in, read from its log.
watch_npm() {
  steplog=$(tail -n "+$(($1 + 1))" "$LOG")
  if printf '%s\n' "$steplog" | grep -q '^gyp info it worked'; then
    # node-gyp compiling a native module: no prebuilt one for this computer.
    LABEL="Building native parts (one time, ~1 min)"
    DETAIL=""
    SLOW_MB=""
  elif printf '%s\n' "$steplog" | grep -q '^npm info run '; then
    LABEL="Setting up Autopilot"
    DETAIL=""
    SLOW_MB=""
  else
    LABEL="Downloading dl"
    SLOW_MB=$NPM_DOWNLOAD_MB
    # First npm looks up each package (one request apiece), then downloads them: about as
    # many as it looked up, so that's the total.
    packages=$(printf '%s\n' "$steplog" | grep -c '^npm http fetch GET 200 [^ ]*\.tgz ') || packages=0
    fetched=$(printf '%s\n' "$steplog" | grep -c '^npm http fetch GET 200 ') || fetched=0
    looked=$((fetched - packages))
    if [ "$packages" -gt 0 ] && [ "$packages" -lt "$looked" ]; then
      DETAIL="$packages of ~$looked packages"
    elif [ "$packages" -gt 0 ]; then
      DETAIL="$packages packages"
    elif [ "$looked" -gt 0 ]; then
      DETAIL="looking up packages ($looked)"
    else
      DETAIL=""
    fi
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

# Whether this computer's tar can unpack .tar.xz: macOS's always can; GNU tar needs xz.
can_unxz() {
  [ "$1" = darwin ] || command -v xz >/dev/null 2>&1
}

# Node.js 24 LTS from nodejs.org into $DL_HOME, checked against its published SHA-256.
# The .tar.xz when tar can unpack it: half the download of the .tar.gz (28 MB, not 53).
install_own_node() {
  base="${DL_NODE_DIST:-https://nodejs.org/dist/latest-v24.x}"
  step "Installing Node.js 24"
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || fail "couldn't reach nodejs.org to download Node.js"
  ext=tar.gz
  if can_unxz "$1"; then ext=tar.xz; fi
  want="-$1-$2.$ext"
  file=$(printf '%s\n' "$sums" | awk -v want="$want" 'substr($2, length($2) - length(want) + 1) == want { print $2; exit }')
  expected=$(printf '%s\n' "$sums" | awk -v file="$file" '$2 == file { print $1; exit }')
  if [ -z "$file" ] || [ -z "$expected" ]; then fail "nodejs.org has no Node.js 24 for $1-$2"; fi
  download="$DL_HOME/$file.download"
  download "$base/$file" "$download" "Downloading Node.js 24"
  STEP="Installing Node.js 24"
  if [ "$(sha256_of "$download")" != "$expected" ]; then
    rm -f "$download"
    fail "the Node.js download didn't match its checksum; try again"
  fi
  dir="${file%."$ext"}"
  # Unpacked aside, then moved into place as $DL_HOME/node itself: one copy of Node, with no
  # versioned directory (or link to one) beside it.
  staging="$DL_HOME/node.unpacking"
  rm -rf "$staging"
  mkdir -p "$staging"
  if [ "$ext" = tar.xz ]; then unpack=-xJf; else unpack=-xzf; fi
  quietly "unpacking Node.js" tar "$unpack" "$download" -C "$staging"
  rm -f "$download"
  [ -x "$staging/$dir/bin/node" ] || fail "the Node.js download has no $dir/bin/node"
  # What dl never uses: the C headers for building native addons (node-gyp downloads its own
  # when it needs them; 67 MB) and the docs.
  rm -rf "$staging/$dir/include" "$staging/$dir/share/doc" "$staging/$dir/share/man" "$staging/$dir/CHANGELOG.md" "$staging/$dir/README.md"
  # The one before: a directory, or (from earlier versions of this script) a link to a
  # node-v* directory beside it. A dl still running keeps its open files.
  rm -rf "${DL_HOME:?}/node"
  mv "$staging/$dir" "$DL_HOME/node"
  rm -rf "$staging"
  for old in "$DL_HOME"/node-v*; do
    if [ -e "$old" ]; then rm -rf "$old"; fi
  done
  node_is_patched "$DL_HOME/node/bin/node" || fail "the Node.js from nodejs.org ($("$DL_HOME/node/bin/node" -v 2>/dev/null || echo '?')) is missing the CVE-2026-111497 fix"
  step_done "Installed Node.js" "$("$DL_HOME/node/bin/node" -v) · in $DL_HOME/node"
}

# The startup file of the user's shell ($1: darwin or linux).
shell_rc() {
  case $(basename "${SHELL:-sh}") in
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$1" = darwin ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
    fish) echo "$HOME/.config/fish/conf.d/directionallylocal.fish" ;;
    *) echo "$HOME/.profile" ;;
  esac
}

# A path as the person would type it, with ~ for the home directory.
tilde() {
  case $1 in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

on_path() {
  case ":$PATH:" in *":$1:"*) return 0 ;; esac
  return 1
}

# A piped install can't change the PATH of the shell it was started from, so the line
# add_to_path writes only reaches new shells. For dl to work in this terminal as well, link it
# into a directory of the user's own that this shell already has on PATH: ~/.local/bin (which
# Ubuntu's ~/.profile adds when it exists) or ~/bin. Never replaces a dl that isn't ours.
link_on_path() {
  for linkdir in "$HOME/.local/bin" "$HOME/bin"; do
    if ! { on_path "$linkdir" && [ -d "$linkdir" ] && [ -w "$linkdir" ]; }; then continue; fi
    linked=""
    for name in dl directionallylocal; do
      if [ -e "$linkdir/$name" ] || [ -L "$linkdir/$name" ]; then
        [ "$(readlink "$linkdir/$name" 2>/dev/null)" = "$DL_HOME/bin/$name" ] || continue
      fi
      ln -sfn "$DL_HOME/bin/$name" "$linkdir/$name"
      if [ "$name" = dl ]; then linked=1; fi
    done
    if [ -n "$linked" ]; then
      step "Linking dl into $(tilde "$linkdir")"
      step_done "Linked dl into $(tilde "$linkdir")" "works in this terminal too"
      return 0
    fi
  done
  return 1
}

# The line that puts $DL_HOME/bin on PATH, in the startup file of the user's shell.
add_to_path() {
  rc=$(shell_rc "$1")
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

# DL_REFERRAL as the free tier service takes it: a GitHub login, lowercased. Fails for anything else.
normalize_referral() {
  code=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case $code in
    ""|-*|*-|*[!a-z0-9-]*) return 1 ;;
  esac
  [ "${#code}" -le 39 ] || return 1
  printf '%s' "$code"
}

# The referral, kept for dl until the free tier sign-in (dl deletes it then). The first one
# stays: a second link before signing in doesn't replace it. Never fails the install.
keep_referral() {
  config="${XDG_CONFIG_HOME:-$HOME/.config}"
  file="$config/directionallylocal/pending-referral"
  if [ -e "$file" ]; then return 0; fi
  (umask 077 && mkdir -p "$config/directionallylocal" && printf '%s\n' "$DL_REFERRAL" >"$file") 2>/dev/null || true
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
  STAGE=node
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

  STAGE=install_dl
  package="${DL_PACKAGE:-directionallylocal@${DL_VERSION:-latest}}"
  step "Installing dl"
  # npm's download cache, and the Node.js headers node-gyp fetches to build a native module,
  # go in a folder of their own that's removed afterwards: dl's packages are installed once,
  # and kept in ~/.npm and ~/.cache/node-gyp they'd take another 190 MB.
  # --loglevel=info and --foreground-scripts put each download and install script in the log,
  # which is where watch_npm reads the progress from.
  NPM_CACHE="$DL_HOME/npm-cache"
  rm -rf "$NPM_CACHE"
  WATCH=watch_npm
  quietly "installing $package" env PATH="$node_dir:$PATH" npm_config_devdir="$NPM_CACHE/node-gyp" "$npm" install -g --prefix "$DL_HOME/dl" --cache "$NPM_CACHE" --no-audit --no-fund --no-update-notifier --loglevel=info --foreground-scripts "$package"
  rm -rf "$NPM_CACHE"
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
  COUNT_VERSION=$("$DL_HOME/bin/dl" --version 2>/dev/null || echo "")
  step_done "Installed dl" "dl $COUNT_VERSION · in $DL_HOME · $(clock "${STEP_SECONDS:-0}")"

  STAGE=path
  if [ "${DL_NO_MODIFY_PATH:-}" != "1" ]; then
    add_to_path "$os"
  fi
  # Whether typing dl in this terminal finds it; when it doesn't, the one line that fixes it.
  fix=""
  if ! on_path "$DL_HOME/bin" && ! link_on_path; then
    if [ "${DL_NO_MODIFY_PATH:-}" = "1" ]; then
      fix="export PATH=\"$DL_HOME/bin:\$PATH\""
    else
      rc=$(shell_rc "$os")
      # sh and dash have no `source`.
      case $rc in */.profile) fix=". $(tilde "$rc")" ;; *) fix="source $(tilde "$rc")" ;; esac
    fi
  fi
  if [ "$os" = linux ]; then
    say "  For a server instead, run it as root: curl -fsSL https://directionallylocal.run | sudo sh"
  fi
  # Interactive: go straight into dl in this folder (plain Autopilot the first time).
  # (DL_TTY stands in for the terminal in tests.)
  tty="${DL_TTY:-/dev/tty}"
  start=""
  if [ "${DL_NO_START:-}" != "1" ] && (exec <"$tty") 2>/dev/null; then start=1; fi
  # When dl isn't started here, the "Then run: … && dl" line at the end says the same as
  # "Next time, …", so only one of the two is printed.
  if [ -n "$fix" ]; then
    say ""
    if [ "${DL_NO_MODIFY_PATH:-}" = "1" ]; then
      remind "dl isn't on your PATH. To use it, run: $fix"
    elif [ -n "$start" ]; then
      remind "Next time, open a new terminal or run: $fix"
    fi
  fi

  if [ -n "${DL_REFERRAL:-}" ]; then keep_referral; fi
  # Installed: counted now, before dl starts (what dl does after is dl's, not the install's).
  count_install ok

  if [ -n "$start" ]; then
    say ""
    code=0
    # DL_REFERRAL (exported in main) goes with it: dl passes it to Autopilot.
    "$DL_HOME/bin/dl" <"$tty" || code=$?
    # Back at the shell this script was piped from, where dl isn't on PATH yet: say so now,
    # when it's needed, as the lines above have scrolled away.
    if [ -n "$fix" ]; then remind "To use dl in this terminal, run: $fix"; fi
    return "$code"
  fi
  if [ -n "$fix" ]; then remind "Then run: $fix && dl"; else say "  Then type: dl"; fi
}

# A line the person needs to act on: bold, so it stands out from the steps above.
remind() {
  if [ -n "$FANCY" ]; then printf '  \033[1m%s\033[0m\n' "$*"; else say "  $*"; fi
}

# Wrapped in a function so a truncated download never runs half a script.
main() {
  if [ -n "$FANCY" ]; then printf '\n  \033[1mDirectionally Local\033[0m\n\n'; else say "Directionally Local"; fi
  case "${DL_MODE:-}" in
    ""|server|laptop) ;;
    *) fail "DL_MODE is server or laptop (got ${DL_MODE})" ;;
  esac
  # An invite link's code stays in the environment of dl (and of dl up, through sudo -E).
  if [ -n "${DL_REFERRAL:-}" ]; then
    if DL_REFERRAL=$(normalize_referral "$DL_REFERRAL"); then
      export DL_REFERRAL
    else
      say "  Ignoring DL_REFERRAL: an invite code is a GitHub username."
      unset DL_REFERRAL
    fi
  fi
  COUNT_MODE=$(install_mode)
  if [ "$COUNT_MODE" = laptop ]; then
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
  STAGE=node
  if ! node_is_patched; then
    line=24
    case "$(node_major)" in 24|26) line=$(node_major) ;; esac
    step "Installing Node.js ${line}"
    quietly "adding the Node.js ${line} repository" as_root sh -c "curl -fsSL https://deb.nodesource.com/setup_${line}.x | bash -"
    quietly "installing Node.js ${line}" as_root apt-get install -y -qq nodejs
    node_is_patched || fail "Node.js $(node -v 2>/dev/null || echo '?') is still missing the CVE-2026-111497 fix; install 22.23.4+, 24.22.1+ or 26.12.1+ and re-run"
    step_done "Installed Node.js" "$(node -v)"
  fi

  STAGE=install_dl
  package="${DL_PACKAGE:-directionallylocal@${DL_VERSION:-latest}}"
  step "Getting the installer"
  quietly "installing $package" as_root npm install -g --no-audit --no-fund --loglevel=error "$package"
  COUNT_VERSION=$(dl --version 2>/dev/null || echo "")
  step_done "Got the installer" "dl $COUNT_VERSION"

  # The laptop's setup stops here: it asks for the keys itself and runs `dl up` next,
  # with its own progress display.
  if [ "${DL_INSTALL_ONLY:-}" = "1" ]; then
    count_install ok
    return 0
  fi

  # Prompts read the terminal, not this piped script. Test by opening it: the device
  # node exists even when there's no controlling terminal.
  # dl up continues the same screen, so it skips its own title.
  export DL_TITLE_SHOWN=1
  STAGE=dl_up
  if (exec </dev/tty) 2>/dev/null; then
    as_root directionallylocal up </dev/tty
  else
    as_root directionallylocal up
  fi
  count_install ok
}

main "$@"
