# Development and releases

Citropy packages Linux x64 as an AppImage, macOS as a zip of `Citropy.app` for arm64 and x64, and Windows x64 as a per-user NSIS installer. Building requires Node.js 22.18 or later, npm, Git, and the system tools needed to compile node-pty. The packaged app includes Electron and its own Node runtime. Users still install and sign in to their chosen provider CLI.

The macOS build is ad-hoc signed, without an Apple certificate, and the app is not notarized. Ad-hoc signing is what Apple Silicon requires to run. The app installs through `scripts/install.sh`, which unpacks it without the quarantine flag, because Gatekeeper blocks a browser-downloaded copy on macOS 15 and later. macOS builds cannot use the Electron updater, so the app's update button runs the same installer. Buying an Apple Developer ID later needs three changes together: a real `mac.identity` with `CSC_LINK`, the hardened runtime turned back on with the Electron entitlements, and notarization credentials. The installer script and the app's update path do not change.

## Development

Run `npm ci`, then `npm run desktop:dev` for the desktop or `npm run dev` for the web interface. Vite serves the interface at `http://127.0.0.1:5177` and proxies to the development backend at port 4178. Ordinary builds use port 4177.

Development uses `~/.citropy-dev` for conversations, settings, terminals, and built-in skills. Its Electron profile is `Citropy Dev` under the operating system's application-data directory. Production uses `~/.citropy` and the `Citropy` desktop profile. Development does not migrate existing Loom or Citropy data. Provider CLI credentials and user-installed skills still belong to their providers and remain shared.

`CITROPY_DATA_DIR`, `CITROPY_DESKTOP_DATA`, `CITROPY_PORT`, and `CITROPY_UI_PORT` override the corresponding defaults. Give additional development instances distinct paths and backend/frontend ports. An occupied frontend port causes startup to fail instead of connecting to a different instance. Do not point development at your production data.

Live-update status, server restart, and provider-event diagnostics appear only in development. Mode is fixed at startup. Packaged builds reject requests to enable development tools and do not collect provider-event diagnostics. Resource usage remains available in both modes.

`npm run desktop:install` installs a normal source-checkout launcher. Build the interface first with `npm run build`. `npm run desktop:install -- --dev` installs a separate **Citropy Dev** launcher with live updates. Neither command installs the AppImage.

## Testing changes

Start with the test files covering the changed behavior, then run type checking:

```sh
node --experimental-strip-types --test tests/shells.test.mjs
npm run typecheck
```

Use the relevant files under `tests/` in place of these examples. Keep performance regressions deterministic by checking unnecessary work or resource cleanup rather than asserting wall-clock timings. Unit tests can advance mocked timers; browser and process integration tests still need to wait for the actual result.

The suite covers only behavior that differs between operating systems: paths, shells and terminals, program lookup, installers, and updates. `npm test` runs it in about ten seconds. Each release job also launches the packaged app on its own operating system.

## Local release check

```sh
npm ci
npm run typecheck
npm test
npm audit --audit-level=high
npm run desktop:package
npm run desktop:smoke
```

The update tests and the smoke check require Xvfb.

Packaging writes the AppImage, `latest-linux.yml`, and the unpacked app to `release/`. The smoke check launches the AppImage with temporary data and verifies startup, shutdown, development restrictions, release contents, and settings at two window widths. Its screenshots also go in `release/`. It does not start a model conversation or consume provider usage.

On macOS, `npm run desktop:package -- --mac` writes `Citropy-<version>-arm64.zip`, `Citropy-<version>-x64.zip`, and `latest-mac.yml`. The zips contain an ad-hoc signed `Citropy.app`; `desktop/smoke-mac.mjs` unpacks both with `ditto`, verifies each signature with `codesign`, checks both main binaries and the node-pty files with `lipo` for the right architecture, and launches the host architecture to check startup and SIGTERM shutdown. The architecture list lives in `desktop/electron-builder.yml`; the packaging command does not narrow it.

On Windows, `npm run desktop:package -- --win` writes `Citropy-<version>-x64-Setup.exe`, its blockmap, and `latest.yml`. The installer is NSIS in one-click mode, per user, so it needs no administrator rights and lands in `%LOCALAPPDATA%\Programs\citropy`. `desktop/smoke-win.mjs` checks the installer and unpacked app contents and launches the packaged app to verify startup. The installer is unsigned, so downloads from a browser carry a SmartScreen warning; installing through `scripts/install.ps1` avoids it because the file never receives the Mark of the Web. Smart App Control on Windows 11 ignores that distinction and blocks unsigned executables outright, which needs a signed build or the setting off. Windows builds update through the Electron updater, using the blockmap for differential downloads.

The package includes the application license, bundled font licenses, and `dist/THIRD_PARTY_NOTICES.txt` for dependencies used at build time. Renderer libraries are bundled into `dist` rather than copied again as runtime dependencies. Source tests, development launchers, Vite, Playwright, local state, and environment files are excluded. The source repository deliberately keeps `private: true` in package.json to prevent accidental npm publication; this does not restrict GitHub releases.

## GitHub release

Every push and pull request runs the **Checks** workflow: type checking, the test suite, a dependency audit, and installer script checks on Linux, plus the portable regressions and backend checks on Linux, macOS, and Windows. The audit includes development dependencies because the renderer bundles some of them into the app. Apps are packaged only by the **Release** workflow, which runs the same checks alongside the builds.

Before releasing, add a `## <version>` section to `CHANGELOG.md` that lists what changed, written for people using the app. The workflow publishes that section as the release notes, and the app shows them before a user updates.

Releases start from the Actions tab with the **Release** workflow. Enter the version to ship, for example `0.2.0`, and run it from `main`. The workflow first rejects anything other than `main`, a version that does not look like `X.Y.Z`, a version that is not greater than the current one, a tag that already exists, and a version without a `CHANGELOG.md` section. After this validation, the checks and Linux, macOS, and Windows builds run in parallel. Only after every check and build passes does it commit the version bump, push the `v<version>` tag, and open a **draft** GitHub release. A failed check or build leaves the repository untouched.

Inspect the draft, then publish it. Publishing is a separate action; ordinary commits and tags do not publish releases.

Keep the AppImage and `latest-linux.yml` together in the published release so the in-app updater can find and verify the download, and keep the zips plus `SHA256SUMS` together so `scripts/install.sh` can find and verify its download. The Linux installer extracts the menu icon from the AppImage it just downloaded. Neither build is signed by a certificate authority. The checksum detects changed downloads but does not replace release signing.

## Context size

New MCP connections advertise `ask_user`, `tool_help`, and `run_tool`. Claude also receives its required approval bridge. `tool_help` returns the existing schemas for one category; `run_tool` dispatches the selected operation through the existing permission, workspace ownership, and cancellation checks. No code evaluation is involved. The full tool list remains visible in the workspace Tools panel.

Existing direct calls continue to work. Existing provider sessions may retain previously loaded schemas until they reconnect. Third-party MCP servers and provider-native tools keep their own context behavior.
