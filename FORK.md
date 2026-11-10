# T3 Code (Custom)

This is a private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) with our own features on top. `AGENTS.md` still applies; this file covers only what the fork adds.

## Branches

| Branch     | What it is                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| `main`     | A mirror of upstream `main`. Never commit here.                                |
| `custom`   | Upstream `main` plus our commits. Builds come from here.                       |
| `t3/*` etc | Feature branches cut from `custom`. Squash each into one commit when it lands. |

`custom` is rebased onto upstream, so its history is rewritten on every sync. Push it with `--force-with-lease` and re-cut open feature branches after a sync.

## Sync with upstream

```sh
git checkout custom
fork/sync-upstream.sh
pnpm exec vp run check:changed
git push --force-with-lease origin custom
git push origin upstream/main:main
```

The script tags the old tip as `custom-before-sync`, so `git reset --hard custom-before-sync` undoes a bad rebase. It turns on `git rerere`, which replays a conflict resolution the next time the same conflict appears.

## Keep the fork easy to rebase

Every line we change in an upstream file is a possible conflict. Keep that surface small:

- Put fork code in new files and new directories. Upstream never touches them.
- Hook new code into upstream files with one line: an import, a route in a list, a component mount. Do not reformat, reorder or rename around it.
- Prefer adding an optional field or a new module over editing an existing function.
- Do not edit upstream tests to make a fork change pass. Make the fork behaviour opt-in so upstream defaults, and the tests that pin them, stay as they are.
- One commit per feature on `custom`. A conflict then names the feature that caused it, and a feature can be dropped with `git rebase --onto`.
- Fork-only tooling lives in `fork/`. Fork-only docs live in this file.
- A feature upstream might take should follow upstream conventions fully, so it can be sent as a PR from a branch cut from `main`.

### Upstream files the fork flavor touches

| File                                      | Change                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/boot.ts`                | Packaged builds default `T3CODE_HOME` to `~/.t3-custom` and the Electron profile to `t3code-custom`. |
| `apps/desktop/src/app/DesktopUserData.ts` | Reads `T3CODE_DESKTOP_USER_DATA_DIR` for the profile directory name.                                 |
| `scripts/build-desktop-artifact.ts`       | Reads `T3CODE_DESKTOP_APP_ID` and `T3CODE_DESKTOP_PRODUCT_NAME`.                                     |
| `AGENTS.md`                               | One line pointing here.                                                                              |

Feature commits list their own touch points in their commit message.

## Build and run

The custom build runs beside the official T3 Code. It has its own app name (`T3 Code (Custom)`), bundle id, Electron profile and data directory (`~/.t3-custom`), and it has no update feed, so it never replaces itself with an upstream release. It shares nothing with `~/.t3`; pair it with your environments once.

Both machines need the repo and its toolchain: Node 26.12.1, pnpm 12, and for the desktop app Rust with Xcode command line tools. `vp` is not installed globally here, so use `pnpm exec vp`.

```sh
git clone git@github.com:tajchert/t3code.git && cd t3code
git remote add upstream https://github.com/pingdotgg/t3code.git
git checkout custom
```

### Desktop app (the laptop)

```sh
fork/build-desktop.sh --install
open -a "T3 Code (Custom)"
```

This builds `release/T3-Code-<version>-arm64.dmg` and copies the app to `/Applications`. The build is ad-hoc signed, not notarized. To build on one Mac and install on another, copy the `.dmg` over and run `xattr -dr com.apple.quarantine "/Applications/T3 Code (Custom).app"` after dragging it in.

### Server (the remote machine)

Run it once in a terminal:

```sh
fork/serve.sh
```

It listens on port 3783 on the LAN and tailnet, keeps state in `~/.t3-custom`, and prints a pairing URL. Port 3783 avoids the official service on 3773. Override with `T3CODE_PORT` and `T3CODE_HOME`.

Keep it running across reboots:

```sh
fork/install-service.sh              # LaunchAgent com.tajchert.t3code.custom.server
fork/install-service.sh --uninstall
```

Mint a pairing link for the running server, then add it in the desktop app under Settings → Environments:

```sh
T3CODE_HOME=~/.t3-custom node apps/server/dist/bin.mjs pair
```

The official background service (`~/.t3`, launchd label `com.t3tools.t3code.service`) keeps running untouched. The custom server does not self-update; update it with the steps below.

### Update either machine

```sh
git checkout custom && git fetch origin && git reset --hard origin/custom
fork/build-desktop.sh --install      # laptop
fork/install-service.sh              # remote: rebuilds and restarts the service
```

Build both from the same commit. The client refuses a server with a different orchestration protocol version.

### Develop

`pnpm exec vp run dev` works as upstream documents and keeps its state in the worktree's `.t3`. The custom data directory applies to packaged builds only.

### Known limits

- The `t3code://` link scheme is shared with the official app, so macOS may open a pairing link in either one. Paste the pairing URL into Settings instead.
- T3 Connect and other cloud features are off unless `.env` carries the upstream `T3CODE_CLERK_*` and `T3CODE_RELAY_URL` values. Use LAN or Tailscale.
