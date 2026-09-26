#!/usr/bin/env bash
# Builds the Linux AppImage: dist-appimage/HoudiniDeck-x86_64.AppImage. It holds the server, the built
# web UI, its run-time packages and the official Node.js 24 for Linux (never this system's node, which a
# distribution may build against its own libraries). Needs Node.js 24+ with npm, curl, tar with xz and
# sha256sum; appimagetool and the AppImage runtime are downloaded (pinned versions, checked).
# CI runs it in .github/workflows/linux-appimage.yml.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
out="$root/dist-appimage"
downloads="$out/downloads"
appdir="$out/HoudiniDeck.AppDir"
app="$appdir/usr/lib/houdinideck"
image="$out/HoudiniDeck-x86_64.AppImage"

# https://github.com/AppImage/appimagetool and https://github.com/AppImage/type2-runtime
appimagetool_url=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
appimagetool_sha256=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
runtime_url=https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64
runtime_sha256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
node_dist=https://nodejs.org/dist/latest-v24.x

fail() {
  echo "build.sh: $*" >&2
  exit 1
}

# Downloads $1 to $2 (unless it's already there) and checks it against the sha256 $3.
fetch() {
  local url=$1 file=$2 sha256=$3
  if [[ ! -f $file ]] || ! echo "$sha256  $file" | sha256sum --check --status; then
    curl --fail --location --silent --show-error --retry 3 --output "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  echo "$sha256  $file" | sha256sum --check --status || fail "$url doesn't match its checksum"
}

[[ $(uname -m) == x86_64 ]] || fail 'this builds the x86_64 AppImage and needs an x86_64 machine'
cd "$root"
version=$(node -p 'require("./package.json").version')
if [[ ${GITHUB_REF_TYPE:-} == tag && ${GITHUB_REF_NAME:-} != "v$version" ]]; then
  fail "the tag $GITHUB_REF_NAME doesn't match the version in package.json ($version)"
fi
(($(node -p 'process.versions.node.split(".")[0]') >= 24)) || fail 'building needs Node.js 24 or newer'

npm ci --no-audit --no-fund
npm run build

# What the AppImage runs: the server, the built web UI and only its run-time packages.
rm -rf "$appdir" "$image"
mkdir -p "$app/web" "$downloads"
cp -r server shared package.json package-lock.json LICENSE README.md "$app/"
cp -r web/dist "$app/web/"
(cd "$app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# The official Node.js for Linux (the newest 24.x), with its license.
node_line=$(curl --fail --location --silent --show-error "$node_dist/SHASUMS256.txt" | grep -E '  node-v24\.[0-9.]+-linux-x64\.tar\.xz$') ||
  fail "no Node.js 24 for linux-x64 at $node_dist"
node_file=${node_line##* }
node_dir=${node_file%.tar.xz}
fetch "$node_dist/$node_file" "$downloads/$node_file" "${node_line%% *}"
mkdir -p "$appdir/usr/bin" "$appdir/usr/share/doc/node"
tar -xJf "$downloads/$node_file" -C "$appdir/usr/bin" --strip-components=2 "$node_dir/bin/node"
tar -xJf "$downloads/$node_file" -C "$appdir/usr/share/doc/node" --strip-components=1 "$node_dir/LICENSE"

# The launcher, the menu entry and the icon.
install -m 755 "$here/AppRun" "$appdir/AppRun"
install -m 644 "$here/houdinideck.desktop" "$appdir/houdinideck.desktop"
install -D -m 644 "$here/houdinideck.desktop" "$appdir/usr/share/applications/houdinideck.desktop"
install -m 644 web/public/app-icon-512.png "$appdir/houdinideck.png"
install -m 644 web/public/app-icon-512.png "$appdir/.DirIcon"
install -D -m 644 web/public/app-icon-512.png "$appdir/usr/share/icons/hicolor/512x512/apps/houdinideck.png"
install -D -m 644 web/public/app-icon.svg "$appdir/usr/share/icons/hicolor/scalable/apps/houdinideck.svg"

fetch "$appimagetool_url" "$downloads/appimagetool-x86_64.AppImage" "$appimagetool_sha256"
fetch "$runtime_url" "$downloads/runtime-x86_64" "$runtime_sha256"
# appimagetool is an AppImage itself. Unpacked once, it runs without FUSE (e.g. in CI) and leaves
# nothing behind in /tmp.
tool="$downloads/appimagetool-$appimagetool_sha256"
if [[ ! -x $tool/AppRun ]]; then
  chmod +x "$downloads/appimagetool-x86_64.AppImage"
  rm -rf "$downloads/squashfs-root" "$downloads"/appimagetool-*/
  (cd "$downloads" && ./appimagetool-x86_64.AppImage --appimage-extract >/dev/null)
  mv "$downloads/squashfs-root" "$tool"
fi
ARCH=x86_64 VERSION=$version "$tool/AppRun" --no-appstream --runtime-file "$downloads/runtime-x86_64" "$appdir" "$image"
node_version=${node_dir#node-v}
echo "Built $image ($(du -h "$image" | cut -f1), Node.js ${node_version%-linux-x64} inside)"
