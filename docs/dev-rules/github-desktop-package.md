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

## Personal signing on one Mac

For a stable local identity across personal builds, run `pnpm release:package --platform darwin --arch arm64 --local-sign` on the owning Mac. This also signs versionless `0.0.0` builds and produces an app ZIP. It uses public metadata at `~/Library/Application Support/CindyLocalSigning/identity.json` with `schemaVersion: 1`, `certificateSha1` (the dedicated code-signing certificate's 40-character SHA-1 fingerprint) and `keychainPath` (the absolute path of the user's login keychain). Create the dedicated certificate through macOS Keychain Access before building. Its private key stays in that keychain under macOS access control.

Each nested code object receives a designated requirement bound to its identifier and that exact certificate. Signing uses no timestamp server or notarization. Retain the same certificate and private key for future builds. `--local-sign` conflicts with `--no-sign` and rejects `--version`, keeping these personal builds on the community `0.0.0` update policy. Without the local flag, existing signing selection applies. The local metadata, certificates, private keys and keychain passwords belong outside the repository. The exported `signLocalMacApp` in `apps/desktop/scripts/ci/local-mac-signing.mjs` also signs an existing personal app copy with the same policy.

The local build first checks the pinned public certificate using macOS's `codeSign` trust policy. A failed check requires the owner to explicitly confirm code-signing trust for that dedicated certificate in Keychain Access. The build itself only checks trust. Local packaging runs the existing packaged smoke test after final signing and before creating the ZIP, subject to `--skip-smoke` and the existing unsupported-host-architecture skip.

Verify signature integrity and identical designated requirements on two distinct builds, then check real Accessibility authorization after replacing the first build with the second. Unit checks cover argument, requirement and smoke-runner selection. Permission continuity requires this native upgrade check.

A stable self-signed designated requirement does not guarantee uninterrupted Keychain access across builds. Apple's public Security implementation assigns a `cdhash:` partition identity to signed code outside its recognized Apple and developer signing categories. A changed CDHash can therefore require renewed Keychain access confirmation despite an unchanged certificate and designated requirement. The specific Keychain ACL and partition state on the tested Mac were not inspected. See [Apple's `partitionIdForProcess` implementation](https://github.com/apple-oss-distributions/Security/blob/main/securityd/src/clientid.cpp#L176-L275).

In the local two-build trial, both builds passed strict signature checks with the same leaf-bound requirement and different CDHashes. The second build stalled in Keychain credential access during isolated smoke and normal startup at the same Applications path. Restoring the first build recovered the account UI and microphone and automatic-input authorization. Native upgrade acceptance must include successful existing-login credential decryption, entry into the main UI, and retention of prior permissions. Preserve failed smoke results and resolve their cause before accepting an upgrade. Do not bypass this acceptance with `--skip-smoke` or broader Keychain ACLs.

CI validates packaged startup and database access. A successful build does not establish real account login, model calls, native permissions, or device connectivity on the user's Mac.
