#!/bin/sh
# Installs or updates Citropy on Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/tinuxongit/Citropy/main/scripts/install.sh | sh
#   sh scripts/install.sh --uninstall
set -eu

REPO="tinuxongit/Citropy"
GITHUB="https://github.com/${REPO}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Citropy install: %s\n' "$*" >&2; exit 1; }

main() {
  VERSION="${CITROPY_VERSION:-}"
  BASE="${CITROPY_BASE_URL:-}"
  UNINSTALL=0
  for argument in "$@"; do
    case "$argument" in
      --uninstall) UNINSTALL=1 ;;
      --version=*) VERSION="${argument#--version=}" ;;
      --help|-h)
        say "Installs or updates Citropy on Linux and macOS."
        say "  --version=X.Y.Z   install a specific release"
        say "  --uninstall       remove the installed app"
        exit 0
        ;;
      *) fail "Unknown option: $argument" ;;
    esac
  done
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=macos ;;
    *) fail "This installer supports Linux and macOS. Download releases for other systems from ${GITHUB}/releases." ;;
  esac
  case "${os}:$(uname -m)" in
    linux:x86_64 | linux:amd64) arch=x86_64 ;;
    linux:aarch64 | linux:arm64) arch=arm64 ;;
    macos:arm64) arch=arm64 ;;
    macos:x86_64) arch=x64 ;;
    *) fail "Unsupported processor: $(uname -m)" ;;
  esac
  if [ "$os" = macos ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi

  name="Citropy"
  command_name="citropy"
  data_hint="$HOME/.citropy and the Citropy profile"
  bin_dir="${CITROPY_BIN_DIR:-$HOME/.local/bin}"
  bin_path="${CITROPY_BIN_PATH:-$bin_dir/$command_name}"
  data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
  app_dir="${CITROPY_APP_DIR:-$HOME/Applications}"
  app="$app_dir/$name.app"
  staging="$app_dir/.$name.app.new"
  previous="$app_dir/.$name.app.old"
  if [ "$os" = macos ]; then
    relaunch_target="$app"
  else
    relaunch_target="$bin_path"
  fi

  tmp=""
  relaunch=""
  if [ "${CITROPY_RELAUNCH:-}" = 1 ]; then
    relaunch="$relaunch_target"
  fi
  wait_for_parent() {
    [ -n "${CITROPY_PARENT_PID:-}" ] || return 0
    count=0
    while kill -0 "$CITROPY_PARENT_PID" 2>/dev/null; do
      count=$((count + 1))
      [ "$count" -lt 60 ] || return 0
      sleep 1
    done
  }
  on_exit() {
    [ -z "$tmp" ] || rm -rf "$tmp"
    if [ -n "$relaunch" ]; then
      wait_for_parent
      if [ "$os" = macos ]; then
        open "$relaunch" >/dev/null 2>&1 || true
      else
        nohup "$relaunch" >/dev/null 2>&1 &
      fi
    fi
  }
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP

  app_pids() {
    ps -Ao pid=,command= 2>/dev/null |
      awk -v exe="$app/Contents/MacOS/$name" '{ pid = $1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, ""); if (index($0, exe) == 1) print pid }'
  }
  quit_macos_app() {
    [ -n "$(app_pids)" ] || return 0
    say "Quitting the running $name..."
    app_pids | xargs kill -TERM 2>/dev/null || true
    count=0
    while [ -n "$(app_pids)" ]; do
      count=$((count + 1))
      [ "$count" -lt 30 ] || fail "$name is still running. Quit it and run this command again."
      sleep 1
    done
  }
  if [ "$UNINSTALL" = 1 ]; then
    if [ "$os" = macos ]; then
      rm -rf "$staging" "$previous"
      if [ -e "$app" ]; then
        quit_macos_app
        rm -rf "$app"
        say "Removed $app"
      else
        say "$name is not installed at $app."
      fi
      say "Your conversations stay in $data_hint. The app profile is in $HOME/Library/Application Support/$name."
    else
      removed=0
      for path in "$bin_path" "$bin_dir/$command_name" "$data_dir/applications/$command_name.desktop" "$data_dir/icons/hicolor/512x512/apps/$command_name.png"; do
        if [ -e "$path" ]; then
          rm -f "$path"
          removed=1
        fi
      done
      if [ "$removed" = 1 ]; then
        say "Removed $name from $bin_dir"
      else
        say "$name is not installed in $bin_dir."
      fi
      say "Your conversations stay in $data_hint. The app profile is in $HOME/.config/$name."
    fi
    exit 0
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required."
  if [ -z "$BASE" ]; then
    BASE="$GITHUB/releases/download"
  fi
  case "$BASE" in
    *@*) fail "Refusing to download from an address with embedded credentials." ;;
  esac
  case "$BASE" in
    http://*)
      case "$BASE" in
        http://127.0.0.1[:/]* | http://localhost[:/]* | 'http://[::1]'[:/]*) ;;
        *) fail "Refusing to download over plain HTTP from a remote host." ;;
      esac
      ;;
  esac

  if [ -z "$VERSION" ]; then
    latest=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$GITHUB/releases/latest") ||
      fail "Could not reach GitHub. Check your connection and try again."
    VERSION=${latest##*/tag/v}
  fi
  if ! printf '%s' "$VERSION" |
    awk -F. 'NF == 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { found = 1 } END { exit !found }'; then
    fail "Version $VERSION does not look like a release. Use a version like 0.2.0."
  fi
  tag="v$VERSION"
  label="Citropy $VERSION"
  if [ "$os" = macos ]; then
    extension=zip
  else
    extension=AppImage
  fi
  asset="Citropy-$VERSION-$arch.$extension"

  if command -v sha256sum >/dev/null 2>&1; then
    hash_file() { sha256sum "$1"; }
  elif command -v shasum >/dev/null 2>&1; then
    hash_file() { shasum -a 256 "$1"; }
  else
    fail "Neither sha256sum nor shasum is available to verify the download."
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/citropy-install.XXXXXX")
  if [ -n "${CITROPY_STAGED_DOWNLOAD:-}" ]; then
    staged="$CITROPY_STAGED_DOWNLOAD"
    if [ ! -f "$staged/$asset" ] || [ ! -f "$staged/SHA256SUMS" ]; then
      fail "The staged release is incomplete. Download it again."
    fi
    ln "$staged/$asset" "$tmp/$asset" 2>/dev/null || cp "$staged/$asset" "$tmp/$asset"
    cp "$staged/SHA256SUMS" "$tmp/SHA256SUMS"
  else
    say "Downloading $label for $os ($arch)..."
    curl -fL --connect-timeout 15 --max-time 600 --retry 3 --retry-delay 1 --retry-connrefused -o "$tmp/$asset" "$BASE/$tag/$asset" ||
      fail "The download failed. Check that $label has a $os $arch build."
    curl -fsSL --connect-timeout 15 --max-time 30 -o "$tmp/SHA256SUMS" "$BASE/$tag/SHA256SUMS" ||
      fail "Could not download SHA256SUMS for $label."
  fi
  expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS" | head -n 1)
  [ -n "$expected" ] || fail "SHA256SUMS does not list $asset."
  actual=$(hash_file "$tmp/$asset" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] || fail "The downloaded file failed its checksum. Try again."

  wait_for_parent

  if [ "$os" = linux ]; then
    mkdir -p "$bin_dir"
    mkdir -p "$(dirname "$bin_path")"
    cp "$tmp/$asset" "$bin_path.new"
    chmod 755 "$bin_path.new"
    mv -f "$bin_path.new" "$bin_path"
    icon=""
    chmod 755 "$tmp/$asset"
    if (cd "$tmp" && "$tmp/$asset" --appimage-extract "usr/share/icons/hicolor/512x512/apps/$command_name.png" >/dev/null 2>&1) &&
      [ -f "$tmp/squashfs-root/usr/share/icons/hicolor/512x512/apps/$command_name.png" ]; then
      mkdir -p "$data_dir/icons/hicolor/512x512/apps"
      cp "$tmp/squashfs-root/usr/share/icons/hicolor/512x512/apps/$command_name.png" "$data_dir/icons/hicolor/512x512/apps/$command_name.png"
      icon="$command_name"
    fi
    if [ -n "$icon" ]; then
      mkdir -p "$data_dir/applications"
      # shellcheck disable=SC2016
      exec_path=$(printf '%s' "$bin_path" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/[$]/\\$/g; s/%/%%/g')
      cat > "$data_dir/applications/$command_name.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$name
Comment=Your workspace for AI conversations and code
Exec="$exec_path" %U
Icon=$icon
Terminal=false
Categories=Development;IDE;
StartupWMClass=$command_name
EOF
      chmod 644 "$data_dir/applications/$command_name.desktop"
      if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$data_dir/applications" >/dev/null 2>&1 || true
      fi
      if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        gtk-update-icon-cache -f "$data_dir/icons/hicolor" >/dev/null 2>&1 || true
      fi
    else
      say "The application icon could not be extracted, so the menu entry was skipped."
    fi
    say "Installed $label at $bin_path"
    say "Open it from your application menu or by running $command_name."
  else
    command -v ditto >/dev/null 2>&1 || fail "ditto is required to unpack the app."
    if [ -n "$(app_pids)" ]; then
      relaunch="$app"
    fi
    quit_macos_app
    mkdir -p "$app_dir"
    ditto -x -k "$tmp/$asset" "$tmp/unpacked" || fail "Could not unpack the downloaded archive."
    [ -d "$tmp/unpacked/$name.app" ] || fail "The downloaded archive did not contain $name.app."
    rm -rf "$staging"
    ditto "$tmp/unpacked/$name.app" "$staging" || fail "Could not copy the app into $app_dir."
    xattr -dr com.apple.quarantine "$staging" >/dev/null 2>&1 || true
    if ! codesign --verify --deep --strict "$staging" >/dev/null 2>&1; then
      printf 'Citropy install: the app signature did not verify; signing it again for this Mac.\n' >&2
      codesign --force --deep --sign - "$staging" >/dev/null 2>&1 || true
    fi
    if ! codesign --verify --deep --strict "$staging" >/dev/null 2>&1; then
      rm -rf "$staging"
      fail "The new app does not have a valid signature on this Mac, so the current installation was left alone."
    fi
    if [ ! -e "$app" ] && [ -e "$previous" ]; then
      say "Restoring the app left behind by an interrupted update."
      mv "$previous" "$app" || fail "Could not restore $app from $previous."
    fi
    rm -rf "$previous"
    if [ -e "$app" ]; then
      mv "$app" "$previous" || fail "Could not move the current app out of the way."
    fi
    if ! mv "$staging" "$app"; then
      if [ -e "$previous" ]; then
        mv "$previous" "$app" || true
      fi
      fail "Could not replace $app."
    fi
    rm -rf "$previous"
    say "Installed $label at $app"
    say "Open it from Launchpad or by running: open \"$app\""
  fi
}

main "$@"
