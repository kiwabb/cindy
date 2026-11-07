# Downloadable Mac builds from GitHub

The `Package desktop for Mac` workflow builds the Global client for Apple Silicon Macs. It uses the existing `release:package` command and its packaged startup/database smoke test. CI wraps that command's ad-hoc-signed app ZIP in a verified DMG with an Applications shortcut. The original ZIP stays available alongside it, and `build-info.json` describes that original packager output.

## Build and download

1. Open the fork's **Actions → Package desktop for Mac → Run workflow**.
2. Choose the source branch. Leave **Publish the tested app to GitHub Releases** enabled for a permanent download.
3. Wait for both jobs to finish. Open **Releases** and download `cindy-unversioned-arm64.dmg`. A copy is also available under the run's `cindy-macos-arm64` artifact for 14 days.
4. Open the DMG and drag `Cindy.app` onto Applications. Launch it from Applications, Launchpad, or Spotlight.

The bootstrap branch `codex/github-packaging` also builds and publishes when pushed. Each release has a unique run/attempt tag, the exact source commit, `build-info.json`, and `SHA256SUMS`.

## Signing and updates

This workflow needs no private release or signing secrets. The existing packager applies ad-hoc signing. The app has no Apple Developer ID notarization, so macOS can block the first launch. After attempting to open this trusted download, use **System Settings → Privacy & Security → Open Anyway** if offered. The workflow does not provide an Apple-trusted public distribution signature.

The upstream community-build version is `0.0.0`, which disables official app updates. Install future builds from this fork's Releases page. The installed app still downloads its required model-engine runtimes on demand.

Packaged builds use their normal application profile. The existing development sandbox is separate, so its login and conversations do not automatically appear in the installed app. Keep the development sandbox when installing, and use the application's supported login and migration features as needed.

CI validates packaged startup and database access. A successful build does not establish real account login, model calls, native permissions, or device connectivity on the user's Mac.
