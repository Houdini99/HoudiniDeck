# Roadmap

Where the project stands and what comes next. Phase 1 (OBS control) and Phase 2 (deck UX) were built and tested on 2026‑09‑25; see the README for what exists. This file covers what is **not** done yet.

## 0. Before anything new: finish verifying Phases 1–2

These need the user and weren't possible during the first build:

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
2. **Editor entry:** add an entry to `ACTION_META` in `shared/actions-meta.ts`, with a new category such as `'System'` / `'Media'` / `'Integrations'` added to `CATEGORIES`. The editor form is generated from its `fields`; new field kinds need a case in `web/src/editor/ActionForm.svelte`.
3. **Executor:** today `server/actions/dispatch.ts` → `run()` only handles `obs.*`. Refactor it into a small registry, e.g. `Record<prefix, (action, phase) => Promise<void>>`, and put each integration in its own file under `server/actions/` (`system.ts`, `http.ts`, `media.ts`, …). Throw `ActionError` for messages the user should see.
4. **State (optional):** if the button lights up or shows live data, add a case to `actionStatus()` in `shared/feedback.ts`.
   - New state that isn't OBS (now playing, system volume, stats) needs its own slice.
   - Add e.g. `{ t: 'ext', media, system }` to `ServerMsg` in `shared/protocol.ts`. Keep it in a store like `ObsStateStore`, broadcast it debounced from `server/hub.ts`, and hold it in `web/src/lib/store.svelte.ts`.
   - `VisualCtx` then needs the new slice.
5. **Tests:** put external processes behind an injectable runner (`(cmd, args) => Promise<{code, stdout, stderr}>`) so executors can be unit-tested without touching the real system.

### Security rules (keep these)

- **Paired devices are trusted to press buttons**, but running arbitrary commands is a bigger step. So `system.command` (and anything that runs a program the user typed) is **off unless the server is started with `STREAMDECK_ENABLE_COMMANDS=1`**. Enforce it in two places:
  - In the executor: refuse with a clear message.
  - When saving the deck: `deck/ops.ts` / the hub rejects adding such actions while disabled.
- **The web UI must not be able to switch this on.** Send the flag to clients in `ServerInfo` so the editor hides the category.
- **Never build shell strings from button parameters for the fixed tools.** Use `execFile` with argument arrays for playerctl, wpctl, nvidia-smi and ydotool.
- **Webhooks:** only `http:`/`https:` URLs, a 10 s timeout, and no following redirects to other schemes.

### Work items (suggested order: least system setup first)

- [ ] **Executor registry refactor** (see "How new actions plug in", step 3). No behavior change; keeps tests green.
- [ ] **`http.request` webhook:** `{ method, url, headers?, body?, timeoutMs? }`.
  - Implement with `fetch` and an AbortController.
  - A non‑2xx response becomes a toast with the status.
  - Use cases: Home Assistant, Streamer.bot, Philips Hue.
- [ ] **`media.player`:** `{ command: playPause|next|previous|stop, player? }` using `playerctl [-p player] play-pause`.
  - **Feedback:** `playerctl --follow metadata --format '{{playerName}}\t{{status}}\t{{artist}}\t{{title}}\t{{mpris:artUrl}}'`, kept running while any client is connected.
  - **Now-playing tile:** show the title, with the art as background when `artUrl` is `file://` or `https://`.
- [ ] **`system.volume`:** `{ target: output|input, mode: toggleMute|mute|unmute|step, db? }` using `wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle` and `wpctl set-volume … 5%+`.
  - **Feedback:** poll `wpctl get-volume @DEFAULT_AUDIO_SINK@` (and `…SOURCE@`) every 2 s while clients are connected. Its output looks like `Volume: 0.45 [MUTED]`.
  - Also usable as a fader tile.
- [ ] **`macro`:** `{ steps: Array<{ action } | { delayMs }>, stopOnError }`.
  - Runs server-side through the dispatcher.
  - **No nested macros and no `deck.*` steps.** Allow up to 20 steps; the editor needs a step list UI.
  - Example: switch scene → unmute mic → start recording.
- [ ] **`system.command`** (gated):
  - Parameters: `{ command, detached?, timeoutMs? }`, run with `sh -c`.
  - `detached` is for launching GUI apps: spawn with `detached: true`, `stdio: 'ignore'`, then `unref()`.
  - On a non-zero exit, show the last lines of stderr in the toast.
  - When the deck runs as a systemd user service, check that `WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` are set, or GUI apps won't start. Plasma usually exports them to the user manager.
- [ ] **`system.stats` tile** (display-only; a new behavior `'display'` in `actions-meta.ts`, where tapping does nothing or opens details):
  - **CPU %:** from `/proc/stat` deltas.
  - **RAM:** from `/proc/meminfo`.
  - **CPU temp:** the k10temp `temp1_input` (Tctl).
  - **GPU %, temperature and VRAM:** `nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used --format=csv,noheader,nounits`.
  - Poll every 2 s, only while a stats tile is on some client's screen (reuse the pattern from `meters.subscribe`).
- [ ] **`system.hotkey` via ydotool:** `{ keys: ['KEY_LEFTCTRL', 'KEY_M'] }` → `ydotool key 29:1 50:1 50:0 29:0`.
  - **Setup (the user does it):** `sudo pacman -S ydotool`, then enable the user service it ships (find the unit with `pacman -Ql ydotool | grep service`).
  - `/dev/uinput` is already writable for the user via ACL.
  - **Editor:** a key recorder that maps `KeyboardEvent.code` to Linux evdev key codes (small lookup table), plus manual entry.
  - **Alternative that needs no setup:** a `kde.shortcut` action calling `qdbus6 org.kde.kglobalaccel /component/<component> invokeShortcut <name>`.
- [ ] **`discord.voice`:** `{ mode: toggleMute|toggleDeafen }` through Discord's local RPC.
  - **Setup (the user does it):**
    1. Create an application at discord.com/developers.
    2. Add `http://localhost` as a redirect.
    3. Put the client ID and secret into Settings; the secret stays server-side in `settings.json` (0600).
  - **Flow:**
    1. Connect to `$XDG_RUNTIME_DIR/discord-ipc-0` (framed JSON: op + length + payload).
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
