# Virtual Stream Deck (HoudiniDeck)

A browser-based Stream Deck for OBS. A Node server (`server/`) holds one obs-websocket connection and syncs a Svelte 5 web app (`web/`) on every device on the LAN. Code shared by both lives in `shared/`. See `README.md` for features and setup. It runs on Linux and Windows 10/11 ("Windows support" in `docs/ROADMAP.md`).

**Start here:** `docs/ROADMAP.md`. Phases 1–4 are done except Discord (Phase 4, "what other stream decks have", is on the branch `feature/more-deck-features`). It lists the checks still pending on the real PC (OBS, and the helper programs of Phases 3 and 4) and what's left. Pick the next unchecked item there, and tick it off (and update the roadmap) when it's done.

## Commands

```bash
npm run dev:mock    # UI + server + fake OBS (http://localhost:5173), no OBS needed
npm run dev         # against the real OBS
npm test            # node:test suites in tests/ (all must pass)
npm run typecheck   # tsc + svelte-check (0 errors AND 0 warnings)
npm run build && npm start   # production on :3325
```

## Conventions that bite

- **Node runs the `.ts` files directly (type stripping):**
  - Only erasable TS syntax works: no `enum`, no namespaces, no constructor parameter properties (`constructor(private x)`).
  - Imports use explicit `.ts` extensions.
- **TypeScript is pinned to ~6.0**, because svelte-check doesn't support TS 7.
- **zod stays server-side.** The browser imports only *types* from `shared/schema.ts` (`import type`). Runtime code in `shared/` that the web app uses must not import zod.
- **Svelte 5 runes** (`$state`, `$derived`, `$props`, `$bindable`). Event attributes are lowercase (`onclick`, `ontoggle`).
- **Container-query units (`cqi`) only work inside a container.** A size container's *own* properties don't resolve against itself; that's why `ButtonFace.svelte` has an `.inner` wrapper.
- **Vite dev proxy:** every entry must use `changeOrigin: false`. The server compares `Host` with `Origin`.
- **The backend dev port is `STREAMDECK_BACKEND_PORT`, not `PORT`.** Tools that launch dev servers set `PORT` to Vite's own port.
- **npm scripts must work in cmd.exe too:** set variables with `cross-env`, never `VAR=value cmd`.
- **Windows:** Linux programs have a Windows path through the PowerShell helper (`server/system/windows/`). Keep `helper.ps1` ASCII-only and its C# at C# 5. An action that can't work on a system gets `platforms` in `ACTION_META`.
- **New action types:** follow the four steps in `docs/ROADMAP.md` ("How new actions plug in") and add tests.
- **Per-button state** (counters, timers, toggles, playing sounds) is keyed by button id; executors get the button as `ActionCtx`. Walk macro steps and toggle sides with `withNested()`.
- **Schema refinements can't call functions typed with `Action`** (the type is still being inferred there): use `behaviorOf()` from `actions-meta.ts`.
- **Security invariants:**
  - Clients send button IDs, never raw actions or OBS calls.
  - Keep the access key out of cookies.
  - The OBS password is write-only from the UI.
  - Command-running actions are gated by `settings.commands`, which only the PC's own browser (trusted local) may change, never a paired device.

## Testing tips

- **The built-in browser pane is usually hidden,** so screenshots lag behind and CSS transitions freeze. Verify state with `read_page`, `find` or JS evaluation, and click by element `ref` when possible.
- **Simulating OBS quitting:** the mock (`npm run dev:mock`) prints its PID. `kill -USR2 <pid>` or `curl http://127.0.0.1:4457/toggle` (also on Windows) toggles OBS off and on. Don't use `SIGUSR1`: Node reserves it for the debugger.
- **Helper programs** (playerctl, wpctl, ydotool, busctl, nvidia-smi, pw-play, wl-copy, xdg-open) run through `server/system/process.ts`, never a shell, and tests pass fakes. To click through their buttons in `dev:mock` without the real programs, put small fake scripts first in `PATH`.
- **Vite HMR sometimes keeps an old Svelte component** in the browser pane after an edit; reload the page before trusting what it shows.
- **Don't press Open Website, Type Text or keyboard-shortcut buttons while testing on the user's PC**: they act on the real desktop. Sounds are safe with a silent WAV.
- **Linux AppImage** (`deploy/linux/appimage/`): `build.sh` builds it locally in seconds, and `node .github/smoke.mjs --appimage dist-appimage/HoudiniDeck-x86_64.AppImage` tries it. `.github/workflows/linux-appimage.yml` only runs for published releases, so after changing it, start it by hand (`gh workflow run linux-appimage.yml --ref <branch>`). Keep `AppRun` POSIX sh. The bundled Node.js is the official build from nodejs.org, never the system's node. Test double-click behavior with a fake `xdg-open` first in `PATH`, so no browser opens on the user's desktop.
- **Windows can't be tried here.** CI (`.github/workflows/ci.yml`) runs the tests, the real PowerShell helper and `.github/smoke.mjs` (starts `npm start` and `npm run dev:mock`) on a Windows runner; check it after pushing. `.github/workflows/windows-installer.yml` builds the installer (`deploy/windows/installer/`) and installs, runs, updates and uninstalls it there. It only runs for published releases, so after changing the installer, start it by hand (`gh workflow run windows-installer.yml --ref <branch>`) and check that run. Keep the installer files ASCII. Tests with shell commands need both an `sh` and a `cmd.exe` version (see `tests/command.test.ts`).
- **The PC's own browser skips pairing.** To test pairing, open the PC's LAN address on port 5173 (Vite prints it as *Network*). The mock data directory is `.data-mock/`.

## Working agreements

- Don't commit or push unless asked. The repo is `github.com/Houdini99/HoudiniDeck`, branch `main`.
- The user must do firewall (ufw), `sudo`, package installs and OBS settings themselves; give them the exact commands.
