#!/bin/sh
# Builds dl's prebuilt bundle for the platform this runs on: dl, its exact dependencies and
# this platform's binaries, as one .tar.gz that the install script unpacks into
# ~/.directionallylocal/dl (the same layout `npm install -g --prefix` makes there).
#
#   scripts/build-bundle.sh SPEC VERSION OUTDIR
#
# SPEC is what npm installs (directionallylocal@0.14.0 in the release workflow, so the bundle
# is exactly what npm serves, and each build counts as an npm download; or a local .tgz to
# test). VERSION is the version it must turn out to be. Writes OUTDIR/dl-VERSION-PLATFORM.tar.gz
# and OUTDIR/dl-VERSION-PLATFORM.line, that bundle's line for dl-bundles.txt:
#   PLATFORM FILE SHA256 BYTES NODE_MAJOR
# Runs on each platform itself (a macOS runner for macOS), so install scripts build for it:
# isolated-vm has no prebuilt binary for Intel Macs, and is compiled here, not on the user's Mac.
set -eu

spec=$1
version=$2
out=$3

os=$(node -p 'process.platform')
arch=$(node -p 'process.arch')
platform="$os-$arch"
node_major=$(node -p 'process.versions.node.split(".")[0]')
case $platform in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *) echo "no bundle for $platform" >&2; exit 1 ;;
esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
npm install -g --prefix "$stage" --no-audit --no-fund --no-update-notifier --foreground-scripts --allow-scripts=isolated-vm "$spec"
pkg="$stage/lib/node_modules/directionallylocal"
built=$(node -p 'require(process.argv[1]).version' "$pkg/package.json")
if [ "$built" != "$version" ]; then
  echo "$spec installed directionallylocal $built, not $version" >&2
  exit 1
fi

# Only this platform's prebuilt binaries (isolated-vm ships every platform's; 15 MB of them).
# A directory is kept when it's for this OS and names this CPU: darwin-arm64, linux-x64,
# darwin-x64+arm64.
find "$pkg/node_modules" -type d -name prebuilds -prune | while IFS= read -r dir; do
  for entry in "$dir"/*; do
    case $(basename "$entry") in
      "$os"-*"$arch"*) ;;
      *) rm -rf "$entry" ;;
    esac
  done
done
# Packages' own tarballs, which nothing loads (isolated-vm 6.2.0 ships a 5 MB copy of itself).
find "$pkg/node_modules" -maxdepth 3 -type f -name '*.tgz' -exec rm -f {} +
# npm's links in bin/: the install script writes its own wrappers.
rm -rf "${stage:?}/bin"

# It works: dl answers, the Autopilot it runs starts, and Code Mode's sandbox (isolated-vm,
# built above where there's no prebuilt binary) loads on this Node.
node "$pkg/bin/directionallylocal.mjs" --version
node "$pkg/node_modules/autopilot-ai/bin/autopilot.mjs" --version
if [ -d "$pkg/node_modules/isolated-vm" ]; then
  node -e 'require(process.argv[1]); console.log("isolated-vm loads")' "$pkg/node_modules/isolated-vm"
fi

mkdir -p "$out"
file="dl-$version-$platform.tar.gz"
# COPYFILE_DISABLE: no macOS ._ resource files in the archive.
COPYFILE_DISABLE=1 tar -czf "$out/$file" -C "$stage" lib
if command -v sha256sum >/dev/null 2>&1; then
  sha=$(sha256sum "$out/$file" | cut -d ' ' -f 1)
else
  sha=$(shasum -a 256 "$out/$file" | cut -d ' ' -f 1)
fi
bytes=$(wc -c <"$out/$file" | tr -d ' ')
printf '%s %s %s %s %s\n' "$platform" "$file" "$sha" "$bytes" "$node_major" >"$out/$file.line"
cat "$out/$file.line"
