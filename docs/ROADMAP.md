# Roadmap

Where the project stands and what comes next. Phase 1 (OBS control) and Phase 2 (deck UX) were built and tested on 2026‑09‑25, and so was Phase 3, except Discord; see the README for what exists. Ticked Phase 3 items keep notes on how they work. The deck also runs on Windows 10/11 (see "Windows support" below).

## 0. Before anything new: verify on the real PC

These need the user's PC and weren't possible where the code was built (a cloud container without OBS, a desktop session or the helper programs):

- [ ] **Test against the real OBS.**
  - The OBS WebSocket server was off (`~/.config/obs-studio/plugin_config/obs-websocket/config.json` → `server_enabled: false`).
  - Once the user enables it and saves the password in Settings, check these:
    - switching between scenes `Scene` and `Switch`;
    - toggling the `Color` source;
    - muting `Audio Capture Device (ALSA)`;
    - start, pause and stop a **recording**;
    - Studio Mode plus a transition.
  - **Never start a stream** during testing; it goes live.
- [ ] **Firewall.** ufw is active. The user runs `sudo ufw allow from 192.168.1.0/24 to any port 3325 proto tcp`; then test from a phone at `http://my-pc.local:3325`.
- [ ] **Autostart (optional).** Install `deploy/virtual-streamdeck.service` as a systemd user unit, only if the user asks. The README has the commands.
- [ ] Fix anything the real‑OBS test turns up. Real obs-websocket 5.6 may differ from `server/dev/mock-obs.ts` in details: `inputKindCaps`, groups, error codes. Update the mock to match.
- [ ] **Check the Phase 3 buttons against the real programs.** They were built against fakes and unit tests; each item below says what to look at:
  - **Media keys** with Spotify and Firefox: the cover art, the PAUSED badge, and which player "whichever played last" controls.
  - **System volume:** mute and fader with the real `wpctl` (WirePlumber 0.5), and that `--limit` is accepted.
  - **Stats tiles:** the k10temp temperature, and GPU numbers from `nvidia-smi`.
  - **Keyboard shortcuts:** after the user installs ydotool and enables its service (README → Requirements).
  - **KDE shortcuts:** the list in the editor, and pressing e.g. KWin → Overview.
  - **Run Command:** only if the user wants it. Start the deck with `STREAMDECK_ENABLE_COMMANDS=1`; with the systemd service, check that apps actually open (the log warns if `WAYLAND_DISPLAY` is missing).

- [ ] **Check on a real Windows 11 PC.** CI (`.github/workflows/ci.yml`) runs the tests, the real PowerShell helper and a start-up smoke test on a Windows runner, but that has no speakers, players or desktop. On the PC:
  - `npm install`, `npm run build`, `npm start` in PowerShell; the firewall question; pairing a phone (is the QR code's address the Wi-Fi/Ethernet one?).
  - **System volume:** mute, step and fader for speakers and microphone; the buttons follow changes made in Windows.
  - **Media keys** with Spotify and a browser: title, cover art, PAUSED badge, "whichever played last" (Windows' current session), and a button naming `spotify`.
  - **Keyboard shortcuts:** e.g. Win+Shift+S, Ctrl+Shift+Esc, a hold button for push-to-talk in Discord, F13–F24 as OBS hotkeys, and Y/Z on a German layout.
  - **Run Command:** a waiting command (`echo hi`), a failing one (the toast shows stderr), **Start an app** with `start "" notepad`, and a timeout.
  - **Stats:** CPU, RAM, and the NVIDIA tiles; CPU temperature says n/a.
  - `settings.json`: `icacls data\settings.json` lists only the user.
  - Autostart through `deploy\windows\virtual-streamdeck.cmd` in the Startup folder.

## Windows support (2026‑09‑25)

Everything but KDE shortcuts works on Windows 10/11. Where Linux runs a program, Windows goes through **one helper**: `server/system/windows/helper.ps1`, a long-running Windows PowerShell 5.1 process that `helper.ts` (`WinHelper`) starts when first needed and again after it stops.

- **Protocol:** JSON lines, `{ id, op, …args }` in and `{ id, ok, data | error }` out, plus `{ event: 'media', state }` while media is watched. Both sides escape everything outside ASCII, so no code page can garble a song title. Button parameters are only ever data in this JSON; no PowerShell code is built from them.
- **Keep `helper.ps1` ASCII** (5.1 reads it in the ANSI code page) and its C# at **C# 5** (no `$"…"`, `?.`, `=>` members): that's what Add-Type compiles with.
- **Ops:** `volume.get`/`volume.set` (Core Audio `IAudioEndpointVolume` of the default device), `keys` (SendInput), `media.state`/`media.control`/`media.watch` (WinRT `GlobalSystemMediaTransportControlsSessionManager`; cover art goes to `%TEMP%\houdinideck-art\`), `ping`.
- **Keys** stay positions: the Linux codes in `shared/keys.ts` are the keyboard's scan codes up to F12, E0-extended ones are mapped in `windows/keys.ts`, and media keys, Pause, Num Lock and F13–F24 go as virtual-key codes. Taps hold the keys 50 ms, since OBS and games poll. Mic Mute has no Windows key.
- **Which code runs:** `app.ts` creates the helper on `win32`; `AudioWatcher` and `systemExecutor` take it as `windows`, and `WindowsMediaWatcher` replaces `MediaWatcher` (both implement `MediaSource`). The helper only starts for decks with Media Keys buttons (while someone looks), System Volume buttons, or Keyboard Shortcut buttons (started early, so the first press doesn't wait for PowerShell).
- **Elsewhere:** Run Command uses `cmd.exe /d /s /c` and `taskkill /t` (`system/command.ts`); stats use `os.cpus()`/`os.freemem()` instead of `/proc`, and CPU temperature is n/a; `settings.json` gets an owner-only ACL through `icacls`; `network.ts` skips `vEthernet (…)` and other virtual adapters.
- **Platform-only actions:** `ACTION_META[type].platforms` (e.g. `['linux']` for `kde.shortcut`). `ServerInfo.platform` tells the browser: the editor doesn't offer such actions, and existing buttons are dimmed. Their executor refuses too.
- **Tests:** `tests/windows.test.ts` covers the Windows code on any system (fake helper, a stand-in helper process in `tests/fake-win-helper.ts`); `tests/windows-helper.test.ts` runs the real helper and only runs on Windows.

## Phase 3: actions beyond OBS

Goal: buttons that do things other than OBS (commands, webhooks, media keys, system volume, hotkeys, macros, Discord) plus a system-stats tile.

### Machine facts (checked 2026‑09‑25)

| Need | Status on this PC |
|---|---|
| Media players (MPRIS) | `playerctl` installed; players show up (e.g. `firefox.instance_…`) |
| System volume | `wpctl` (PipeWire) and `pactl` installed |
| CPU temperature | `/sys/class/hwmon/*/name == k10temp` (currently hwmon4; **look it up by name**, the numbers change) |
| GPU | NVIDIA GPU, `nvidia-smi` installed. The AMD iGPU has a hwmon `amdgpu` sensor too |
| Keystrokes on Wayland (KDE) | `ydotool` **not installed** (in the repos, 1.0.4). `/dev/uinput` already has an ACL `user:<you>:rw-` (seat ACL). `xdotool` exists but only reaches XWayland windows |
| KDE shortcuts | `qdbus6` installed (`org.kde.kglobalaccel` can trigger any global shortcut) |
| Discord | Official client (not Vesktop). IPC socket at `$XDG_RUNTIME_DIR/discord-ipc-0` |

### How new actions plug in (existing pattern)

For each action type:

1. **Schema:** add to `ActionSchema` in `shared/schema.ts`. Prefix the type by area: `system.*`, `http.*`, `media.*`, `macro`, `discord.*`.
2. **Editor entry:** add an entry to `ACTION_META` in `shared/actions-meta.ts`, with a new category such as `'System'` / `'Media'` / `'Integrations'` added to `CATEGORIES`. If it can't work on every system, set `platforms` (see "Windows support"), or give it a Windows path through the helper. The editor form is generated from its `fields`; new field kinds need a case in `web/src/editor/ActionForm.svelte`. A field with `show` only appears (and is only required) while `show(action)` is true.
3. **Executor:** each family of actions (the type prefix: `obs`, `http`, …) has one executor, `(action, phase) => Promise<void>`, in its own file under `server/actions/` (`obs.ts`, `http.ts`, `media.ts`, …). Add it to `createExecutors()` in `server/actions/registry.ts`. The registry type lists every prefix, so a new prefix without an executor doesn't compile. Throw `ActionError` (from `server/actions/executor.ts`) for messages the user should see.
4. **State (optional):** if the button lights up or shows live data, add a case to `actionStatus()` in `shared/feedback.ts`.
   - State that isn't OBS (now playing, system volume, stats) goes into `ExtState` in `shared/ext-types.ts`; add a field for the new slice.
   - A watcher under `server/system/` (see `media.ts`) writes it into the `ExtStore` (`server/ext-store.ts`) and calls `changed()`. The hub then sends a debounced `{ t: 'ext' }` message, and the browser keeps it in `store.ext`.
   - Buttons see it as `ctx.ext` in `actionStatus()` (`VisualCtx`) and in `autoLabel` (`LabelCtx`).
   - Run watchers only while someone looks: the hub calls `setActive()` as browsers come and go.
5. **Tests:** run helper programs through `server/system/process.ts`: a `Runner` (`(cmd, args) => Promise<{code, stdout, stderr}>`) for one-off commands, a `Spawner` for long-running ones read line by line. Tests pass fakes (see `tests/media.test.ts`), so nothing touches the real system.

### Security rules (keep these)

- **Paired devices are trusted to press buttons**, but running arbitrary commands is a bigger step. So `system.command` (and anything that runs a program the user typed) is **off unless the server is started with `STREAMDECK_ENABLE_COMMANDS=1`**. Enforce it in two places:
  - In the executor: refuse with a clear message.
  - When saving the deck: `deck/ops.ts` / the hub rejects adding such actions while disabled.
- **The web UI must not be able to switch this on.** Send the flag to clients in `ServerInfo` so the editor hides the category.
- **Never build shell strings from button parameters for the fixed tools.** Use `execFile` with argument arrays for playerctl, wpctl, nvidia-smi and ydotool. On Windows, parameters go to the helper as JSON data, never as PowerShell code.
- **Webhooks:** only `http:`/`https:` URLs, a 10 s timeout, and no following redirects to other schemes.

### Work items (suggested order: least system setup first)

- [x] **Executor registry refactor** (see "How new actions plug in", step 3). No behavior change, except that rapid fader moves are now coalesced per button instead of per OBS input. `tests/dispatch.test.ts` covers the dispatcher with fake executors.
- [x] **`http.request` webhook:** `{ method, url, headers?, body?, timeoutMs? }`, in `server/actions/http.ts`.
  - `fetch` with `AbortSignal.timeout` (10 s unless the button sets `timeoutMs`).
  - A non‑2xx response becomes a toast with the status; network errors get a readable reason (refused, host not found, certificate not trusted, …).
  - A body that is valid JSON goes out as `application/json` unless a Content-Type header is set. GET requests never send a body.
  - `user:password@` in the URL becomes a Basic `Authorization` header (fetch refuses such URLs).
  - The editor gained the `url`, `multiline` and `headers` field kinds.
  - Use cases: Home Assistant, Streamer.bot, Philips Hue.
- [x] **`media.player`:** `{ command: playPause|next|previous|stop, player?, nowPlaying? }`, in `server/actions/media.ts` and `server/system/media.ts`.
  - **Feedback:** `playerctl --follow metadata --format '{{playerInstance}}\t{{status}}\t{{artist}}\t{{title}}\t{{mpris:artUrl}}'`, running while any client is connected. In follow mode playerctl reports the player that changed last. Every player a button names gets its own `--player <name>` follower.
  - **Commands:** without a named player they go to `--player <instance>` of the followed player, so the button controls what it shows. Plain `playerctl play-pause` would pick the first player it lists.
  - **Now-playing tile** (`nowPlaying`, on by default for new buttons): the title as the label, and the art filling the button. `https://` art is used as is; `file://` art is served at `/api/media/art/<random token>` (only the current track's file, and only if it is an image). A PAUSED badge shows when paused.
  - Checked against a fake playerctl and in unit tests. **Still to check on the PC** with real players (Spotify, Firefox): that the art shows, and which player "whichever played last" picks.
- [x] **`system.volume`:** `{ target: output|input, mode: toggleMute|mute|unmute|step|fader, step? }`, in `server/actions/system.ts` and `server/system/audio.ts`.
  - **Commands:** `wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle|1|0`. Steps are in percent (`5%+`, `10%-`); turning up uses `--limit=1.0` so it stops at 100%, like the desktop's volume keys. The fader sets the volume directly (0–1).
  - **Feedback:** `wpctl get-volume @DEFAULT_AUDIO_SINK@` (and `…SOURCE@`) every 2 s, only while a browser is connected and the deck has a System Volume button for that device, plus right after each button press. Its output looks like `Volume: 0.45 [MUTED]`. Only changes are broadcast.
  - **Fader tile:** any action whose behavior is `fader` now gets the fader tile. The tile shows the percentage and has no level meter.
  - Checked against a fake wpctl and in unit tests. **Still to check on the PC** with the real wpctl (WirePlumber 0.5): the output format, and that `--limit` is accepted.
- [x] **`macro`:** `{ steps: Array<{ action } | { delayMs }>, stopOnError }`, in `server/actions/macro.ts`.
  - Steps run server-side through the same executor registry, as presses.
  - **No nested macros and no `deck.*` steps:** the schema splits `StepActionSchema` (everything else) from `ActionSchema`. Steps that need holding or dragging (push-to-talk, faders) are refused too. Up to 20 steps, pauses up to 60 s.
  - `stopOnError` (default on) stops at the first failed step and names it in the toast. Otherwise the rest still run, and the failures are listed at the end.
  - A second tap while the macro is still running is refused.
  - Editor: `web/src/editor/MacroSteps.svelte`, a step list with a form per step, reordering and pauses.
  - Example: switch scene → unmute mic → start recording.
- [x] **`system.command`** (gated), in `server/actions/system.ts` and `server/system/command.ts`:
  - Parameters: `{ command, detached?, timeoutMs? }`, run with `sh -c` in the home folder, without `OBS_PASSWORD` in its environment.
  - **Gate:** `STREAMDECK_ENABLE_COMMANDS=1` (`env.commandsEnabled`). The executor refuses otherwise. `applyOp` refuses any edit whose result has a command the deck didn't have before (`refuseNewCommands`: added, changed, duplicated, imported, or inside a macro). `ServerInfo.commands` tells the editor, which then hides the action and dims existing command buttons.
  - Waiting mode (default 30 s timeout): the command leads its own process group, so a timeout stops everything it started. The toast shows the exit code and the last lines of stderr. Programs it leaves in the background don't hold up the button.
  - `detached` (for GUI apps): spawned with `detached: true`, `stdio: 'ignore'`, then `unref()`. It's watched for one second so "command not found" (exit 127) still gets a toast.
  - At startup with commands on, the server warns if `WAYLAND_DISPLAY`/`DISPLAY` or `DBUS_SESSION_BUS_ADDRESS` is missing (e.g. under systemd), since GUI apps then won't open.
- [x] **`system.stats` tile** `{ metric: cpu|memory|cpuTemp|gpu|gpuTemp|gpuMemory }`, in `server/system/stats.ts`. It is display-only: a new behavior `'display'`, where tapping does nothing but a long press can still have an action.
  - **CPU %:** from `/proc/stat` deltas (the second reading comes 0.5 s after the first).
  - **RAM:** `MemTotal − MemAvailable` from `/proc/meminfo`.
  - **CPU temp:** `temp1_input` of the hwmon whose `name` is `k10temp` (then `zenpower`, `coretemp`). It's found by name, and looked up again if the read fails.
  - **GPU %, temperature and VRAM:** one `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits` call per poll, only when a GPU tile is shown. Without nvidia-smi the tiles say n/a.
  - Polled every 2 s, only for the metrics on some client's screen: tiles subscribe with `{ t: 'stats', metrics }`, the same pattern as the level meters (`Interest` in the web store).
  - The tile shows a big value with a small bar under it, amber when warm and red when hot (e.g. CPU ≥ 70/85 °C).
  - **Still to check on the PC:** the k10temp reading, and nvidia-smi's output on the NVIDIA GPU.
- [x] **`system.hotkey` via ydotool:** `{ keys: ['KEY_LEFTCTRL', 'KEY_M'], hold? }` → `ydotool key 29:1 50:1 50:0 29:0`.
  - `shared/keys.ts` holds 125 keys with their evdev codes, checked against `linux/input-event-codes.h`, plus labels and `KeyboardEvent.code` names.
  - `hold`: the keys go down on press and up on release (behavior `'hold'`), so a disconnecting device releases them too. E.g. push-to-talk.
  - Errors checked against ydotool 1.0.4's source. It reports a missing daemon on **stdout** ("failed to connect socket …", exit code 2); the toast then gives the `systemctl --user enable --now ydotool` command.
  - **Editor:** `KeysField.svelte` has Ctrl/Shift/Alt/Super toggles plus a grouped key list (works on touch screens), and a recorder for a physical keyboard. Keys are positions on a US layout (Y/Z swap on German keyboards); recording gets that right.
  - **Setup (the user does it):** `sudo pacman -S ydotool`, then enable the user service it ships (find the unit with `pacman -Ql ydotool | grep service`). `/dev/uinput` is already writable for the user via ACL.
  - **Still to check on the PC** after that setup.
- [x] **`kde.shortcut`** `{ component, shortcut, title? }` (the alternative that needs no setup), in `server/system/kde.ts`. It uses `busctl --user --json=short -- call org.kde.kglobalaccel …` instead of qdbus6: busctl comes with systemd and prints JSON.
  - Checked against kglobalacceld's source: the component path is `/component/<unique name>` with anything outside `A–Z a–z 0–9 _` turned into `_`, and `allShortcutInfos` returns `a(ssssssaiai)` starting with unique name, friendly name, component unique, component friendly.
  - `invokeShortcut` silently ignores unknown names, so a press checks `shortcutNames` first and reports a missing shortcut.
  - The editor lists apps and shortcuts by friendly name (query `kdeShortcuts`: `allComponents` + `allShortcutInfos`). Without Plasma, both are text boxes.
  - **Still to check on the PC** (Plasma 6).
- [ ] **`discord.voice`:** `{ mode: toggleMute|toggleDeafen }` through Discord's local RPC.
  - **Setup (the user does it):**
    1. Create an application at discord.com/developers.
    2. Add `http://localhost` as a redirect.
    3. Put the client ID and secret into Settings; the secret stays server-side in `settings.json` (0600).
  - **Flow:**
    1. Connect to `$XDG_RUNTIME_DIR/discord-ipc-0`, on Windows the named pipe `\\?\pipe\discord-ipc-0` (framed JSON: op + length + payload; Node's `net.connect` handles both).
    2. `AUTHORIZE` with scopes `rpc rpc.voice.read rpc.voice.write`; the user clicks Authorize in Discord once.
    3. Exchange the code for a token at `https://discord.com/api/oauth2/token`, then `AUTHENTICATE`.
    4. Toggle with `SET_VOICE_SETTINGS {mute}` / `{deaf}`.
    5. For button feedback, `SUBSCRIBE VOICE_SETTINGS_UPDATE`.
  - Store the refresh token. RPC voice scopes only work for accounts on the app's team, which is fine for personal use.
  - **Fallback:** bind a Discord keybind and use `system.hotkey`.

### Later / nice to have

- **Live scene thumbnails on scene buttons:** `GetSourceScreenshot` at small size, throttled, only for visible buttons. Opt-in per button, because it costs OBS CPU.
- **Optional HTTPS** with a self-signed certificate. Plain http blocks the Wake Lock API, installable PWAs and the clipboard.
- **Per-device layouts**, or picking the start page automatically by screen size.
- **Garbage-collect** unreferenced files in `data/uploads/`.
