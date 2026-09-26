# Virtual Stream Deck

A self-hosted Stream Deck for OBS that runs in the browser. It runs on the PC with OBS (Linux or Windows 11); open it on a tablet, phone or laptop on the same network, and every device stays in sync.

- **OBS control:**
  - Scenes, with Program/Preview highlighting in Studio Mode, and optionally a live picture of the scene on the button.
  - Source visibility and filters; set the text of a text source; refresh a browser source (stuck alerts or chat).
  - Mute, push-to-talk/push-to-mute, and volume faders with live meters.
  - Stream, record (pause, split, chapters), replay buffer and virtual camera.
  - Transitions, screenshots, scene collections and profiles, OBS hotkeys, and media sources.
  - Stream health tiles: dropped frames and bitrate while live, frame rate, OBS's CPU use, rendering and encoding lag.
- **Beyond OBS:**
  - Media keys for music and videos on the PC (Spotify, browsers, VLC, …), optionally showing the song and its cover art.
  - **Soundboard:** buttons that play MP3 or WAV clips on the PC's speakers (OBS hears them through Desktop Audio), a second press stops or restarts them, and a Stop All button.
  - The PC's own volume: mute or step the default speakers or microphone, or drag a fader.
  - Live system stats tiles: CPU load and temperature (Linux only), memory, and NVIDIA GPU load, temperature and memory.
  - Keyboard shortcuts sent to the PC, optionally held while you hold the button (push-to-talk), and **Type Text** for chat messages and the like.
  - **Open Website:** a page in the PC's browser, e.g. your stream dashboard.
  - Linux with KDE Plasma: any Plasma global shortcut (Overview, Spectacle, Mute Microphone, …), picked from a list. Needs no setup.
- **Timers and counters:** a countdown or stopwatch, a counter (deaths, wins, …) and a clock, the same on every device. Counters and timers can write into an OBS text source, e.g. "Starting in 4:59" or "Deaths: 12" on stream, and they survive restarts.
- **Macros and toggles:** one button runs several actions in a row, with pauses, e.g. switch scene, unmute the mic, start recording. A toggle runs one action on the first press and another on the next (lights on/off), and stays lit in between.
- **Run Command (off by default):** a button starts a program or script on the PC. See [Security](#security).
  - Webhook buttons that send an HTTP request, e.g. to Home Assistant, Streamer.bot or a Philips Hue bridge.
- **Press buttons from other apps:** Streamer.bot, Home Assistant, Bitfocus Companion or a script can press any deck button over HTTP (see [below](#press-buttons-from-other-apps)).
- **A real deck:**
  - Any grid size, several pages, folders, and Next/Previous Page buttons.
  - Drag-and-drop editing, **undo and redo** (Ctrl+Z), and copying buttons or whole pages.
  - Icons (Material Design and brand logos), uploaded images, emoji and colors; the label at the top, middle or bottom, in three sizes.
  - A separate look while a button is active, long-press actions, and "tap twice" protection for Stream.
- **Built for touch:**
  - Buttons fire on touch-down, and hold-to-talk works.
  - Compact mode, fullscreen or Add to Home Screen, keep-the-screen-on, and dimming after a few idle minutes (the tap that wakes it presses nothing).
- **Survives restarts:** buttons are remembered by OBS's internal IDs, so renaming a scene in OBS doesn't break them. The deck reconnects on its own when OBS restarts, and a tablet reloads by itself after an update.

## Requirements

- Linux or Windows 10/11, on the PC that runs OBS.
- Node.js 24.2 or newer. Node runs the TypeScript server directly, so there's no build step for the server.
- OBS Studio 28 or newer, which has obs-websocket 5 built in.

## Install

### On Linux

1. Install Node.js and git (CachyOS/Arch; on other distributions use their package manager, or get Node.js 24 from nodejs.org):

   ```bash
   sudo pacman -S nodejs npm git
   ```

2. Get the deck, build its web UI and start it:

   ```bash
   git clone https://github.com/Houdini99/HoudiniDeck.git
   cd HoudiniDeck
   npm install
   npm run build
   npm start
   ```

3. Optional: `playerctl`, for the media keys (`sudo pacman -S playerctl`). The system volume buttons use `wpctl`, and sound buttons `pw-play`; both come with PipeWire.
4. Optional: `ydotool`, for keyboard shortcuts and Type Text. It types through the kernel, so it works on Wayland:

   ```bash
   sudo pacman -S ydotool
   pacman -Ql ydotool | grep service           # shows where its service unit is
   systemctl --user enable --now ydotool       # if the unit is under /usr/lib/systemd/user
   ```

   The ydotool service needs write access to `/dev/uinput`.

   Type Text pastes its text through the clipboard. KDE Plasma's clipboard works as it is; elsewhere install `wl-clipboard` (`sudo pacman -S wl-clipboard`).

### On Windows 10/11 with the installer (easiest)

Download `HoudiniDeck-Setup-<version>.exe` from the [Releases page](https://github.com/Houdini99/HoudiniDeck/releases) and run it. It brings its own Node.js, so there's nothing else to install.

- **"Windows protected your PC":** the installer isn't code-signed, so SmartScreen warns about it. Click **More info → Run anyway**.
- **Options while installing:** let phones and tablets connect (a Windows Firewall rule, private networks only), start HoudiniDeck when you log in, and a desktop icon.
- **Start it** from the Start menu (**HoudiniDeck**); it opens in your browser. The terminal window that comes with it is the deck itself: closing it stops the deck. Starting it again while it runs just opens the browser.
- **Your deck, settings and images** live in `%LOCALAPPDATA%\HoudiniDeck` (Start menu → **HoudiniDeck data folder**). Settings such as `PORT` go into a `.env` file there (see [Configuration](#configuration)).
- **Update:** run the newer installer. It stops the deck and keeps your deck and settings.
- **Uninstall:** Settings → Apps → Installed apps → **HoudiniDeck** → Uninstall. It removes the program, its shortcuts and its firewall rule, and asks whether to delete your deck and settings too.

### On Windows 10/11 from the source code

For development, or to run the newest code from GitHub.

1. Install Node.js and git. In PowerShell (or the Command Prompt):

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```

   Then **close the terminal and open a new one**, so it finds `node`, `npm` and `git`. (Without winget: the installers from nodejs.org and git-scm.com. Without git: on GitHub, **Code → Download ZIP**, unpack it, and open a terminal in that folder.)
2. Get the deck, build its web UI and start it:

   ```powershell
   git clone https://github.com/Houdini99/HoudiniDeck.git
   cd HoudiniDeck
   npm install
   npm run build
   npm start
   ```

   If PowerShell says *"npm.ps1 cannot be loaded because running scripts is disabled on this system"*, allow scripts for your account once, then run the command again:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

   (Or use the Command Prompt, `cmd`, which doesn't have this restriction.)
3. The first time the deck starts, Windows asks whether Node.js may use the network: allow it for **private networks** (see "Open the deck on a phone or tablet" below).
4. Nothing else to install. Media keys, system volume and keyboard shortcuts use Windows PowerShell, which every Windows has; the GPU tiles use `nvidia-smi`, which comes with the NVIDIA driver.

### Updating (from the source code)

In the deck's folder, stop it (Ctrl+C), then:

```bash
git pull
npm install
npm run build
npm start
```

Open tablets reload by themselves.

## Quick start

Once the deck runs (`npm start`, or **HoudiniDeck** from the Windows Start menu), open <http://localhost:3325> on the PC. The terminal prints the addresses for your other devices and a QR code for pairing them.

### 1. Turn on OBS's WebSocket server

1. In OBS, open **Tools → WebSocket Server Settings** and tick **Enable WebSocket server**. Keep authentication on.
2. Click **Show Connect Info** and copy the password.
3. On the deck, open **Settings** (the ⚙ in the top bar), paste the password under *OBS connection*, and click **Save and connect**.

On an empty page, **Generate from OBS** creates buttons for your scenes, audio inputs and outputs.

### 2. Open the deck on a phone or tablet

Phones and tablets need an access key (see [Security](#security)).

1. **Allow the port through the firewall.**
   - **Linux:** CachyOS ships with ufw enabled; allow your LAN (adjust the subnet if yours differs):

     ```bash
     sudo ufw allow from 192.168.1.0/24 to any port 3325 proto tcp comment 'Virtual Stream Deck'
     ```

     To use the deck over a VPN such as WireGuard too, add the same rule for its subnet (e.g. `10.8.0.0/24`).
   - **Windows:** with the installer's firewall option, this is done. Otherwise, the first time the deck starts, Windows asks whether Node.js may use the network: allow it for **private networks**. Your home network must be set to private (Settings → Network & internet → your Wi-Fi or Ethernet → Network profile type: **Private**). If you missed the question, run this in PowerShell as administrator:

     ```powershell
     New-NetFirewallRule -DisplayName 'Virtual Stream Deck' -Direction Inbound -Protocol TCP -LocalPort 3325 -Action Allow -Profile Private
     ```
2. **Pair the device.** Scan the QR code in the server's terminal with its camera, or scan it from **Settings → Pair a phone or tablet** on a device that's already paired. The address is `http://<the PC's name>.local:3325` (e.g. `http://my-pc.local:3325`), or the IP printed at startup.
3. **Optional:** add it to the home screen (iPhone/iPad: Share → Add to Home Screen; Android: ⋮ → Add to Home screen) so it opens fullscreen.

### Using the deck

- Each device remembers its own page. Switch pages with the tabs at the top, or with **Open Page / Folder** buttons.
- **✎ (Edit)** enters edit mode:
  - Tap **+** to add a button, and tap a button to edit it.
  - Drag a button to move it, or drop it on a page tab to move it to that page. On touch screens, hold for a moment and then drag.
  - **Pages** adds, renames, resizes and reorders pages.
- **Volume faders:** drag up or down to change the volume, tap to mute.
- **Push-to-talk buttons** unmute only while you hold them. If the device drops off the network mid-press, the server mutes again.
- **Undo:** in edit mode, the ↶ and ↷ buttons in the top bar (or Ctrl+Z and Ctrl+Shift+Z) take back and redo the last edits, made on any device.
- **Counters and timers:** tap to count or to start and pause; a long press resets (new buttons come with that long press). Other buttons, and macro steps, can change the same counter or timer: pick it under "Which counter" / "Which timer". A countdown that ran out flashes until you tap it.
- **Sounds:** add a Play Sound button and upload an MP3 or WAV. It plays on the PC's default speakers, so OBS hears it through Desktop Audio (as do you). "Listen here" in the editor plays it on the device you edit on.
- **Live scene pictures:** tick "Show a live picture of the scene" on a Switch Scene button. OBS renders a small picture every 2 seconds while the button is on some screen, which costs it a little GPU and CPU.

### Press buttons from other apps

Any program on your network that can send an HTTP request can press a deck button, e.g. Streamer.bot, Home Assistant (`rest_command`), Bitfocus Companion or a script. Open the button in the editor → **Press it from other apps** for the exact command, which looks like this:

```bash
curl -X POST -H "Authorization: Bearer <access key>" http://my-pc.local:3325/api/buttons/<button id>/press
```

- Add `?which=longPress` to run the button's long-press action.
- `GET /api/buttons` (with the same header) lists every button with its id, page and label.
- The access key is the one in the pairing link (`#k=…`). On the PC itself, `http://localhost:3325/…` works without it.
- In Windows PowerShell, type `curl.exe` instead of `curl`.
- Push-to-talk, faders, page navigation and display tiles can't be pressed this way.

## Configuration

Everything can be set from the UI. These environment variables, optionally in a `.env` file (see `.env.example`), override it:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3325` | Port the deck listens on |
| `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` = this PC only) |
| `OBS_URL` | `ws://127.0.0.1:4455` | obs-websocket address |
| `OBS_PASSWORD` | – | obs-websocket password. When `OBS_URL`/`OBS_PASSWORD` are set, Settings can't change the connection |
| `STREAMDECK_DATA_DIR` | `./data` | Where the deck, settings and images are stored (the Windows installer's version: `%LOCALAPPDATA%\HoudiniDeck`, fixed) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

The easiest place for them is the `.env` file, on Linux and Windows alike: in the project folder, or for the Windows installer's version in its data folder (Start menu → **HoudiniDeck data folder**; restart the deck afterwards). To set one for a single run instead: `PORT=4000 npm start` in bash, `$env:PORT=4000; npm start` in PowerShell.

### Data and backups

```
data/                (the Windows installer's version: %LOCALAPPDATA%\HoudiniDeck)
  deck.json          pages and buttons
  settings.json      OBS connection + access key (file mode 0600)
  button-state.json  counter counts, running timers and which toggles are on
  uploads/           button images and sounds
  backups/           older deck.json versions (automatic, last 20)
```

**Settings → Backup** can also export and import the whole deck as a JSON file. A deck file that can't be read is renamed to `deck.json.corrupt-<time>` rather than overwritten.

### Start it automatically on login (optional)

**Windows with the installer:** tick "Start HoudiniDeck when I log in" while installing (run the installer again to change it).

**Windows from the source code:** `deploy\windows\virtual-streamdeck.cmd` starts the deck like `npm start` does. Run `npm run build` once, then:

1. Press Win+R, type `shell:startup` and press Enter. The Startup folder opens.
2. Right-click `deploy\windows\virtual-streamdeck.cmd` in the project folder → **Show more options → Send to → Desktop (create shortcut)**, and move that shortcut into the Startup folder.
3. Optional: in the shortcut's **Properties**, set **Run** to **Minimized**.

The deck then runs in a terminal window after you log in; closing that window stops it. After updating the code, run `npm run build` and restart it. Open tablets reload by themselves.

**Linux:** a systemd user unit is included. It assumes the project lives in `~/HoudiniDeck` (cloned into your home folder); edit `WorkingDirectory` if not.

```bash
npm run build
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/deploy/virtual-streamdeck.service" ~/.config/systemd/user/virtual-streamdeck.service
systemctl --user daemon-reload
systemctl --user enable --now virtual-streamdeck.service
```

Run Command buttons started by the service need your desktop session's variables. Plasma normally passes them to systemd; if the log warns that `WAYLAND_DISPLAY` is not set, run `systemctl --user import-environment WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS` and restart the service.

Read the logs with `journalctl --user -u virtual-streamdeck -f`. After updating the code, run `npm run build` and `systemctl --user restart virtual-streamdeck`. Open tablets reload by themselves.

## Security

The deck controls your stream, so it's locked down even on a home network:

- **Pairing:**
  - A device must present the **access key**. The QR code and the pairing link carry it in the URL fragment (`#k=…`), which browsers never send to the server.
  - The key is kept in the device's browser storage, never in a cookie. That way other websites can't use a paired browser to press buttons (no CSRF, no DNS-rebinding tricks).
  - **Settings → New key** logs out every other device.
- **The PC itself needs no key,** but only when the request both arrives over loopback and is addressed to `localhost`/`127.0.0.1`.
- **Other websites are refused:** WebSocket connections and uploads from a different origin are rejected.
- **Secrets stay on the server:** the OBS password is never sent to browsers, and `settings.json` is readable only by you (on Windows, its access list names only your account).
- **Uploads:** only real images are accepted (checked by content), and they're served with `nosniff` and a sandboxing CSP.
- **Run Command buttons are off by default.**
  - Turned on, they let every paired device run any program as you. So only the browser on the PC itself (`http://localhost`) can turn them on or off: **Settings → Run Command buttons**. Paired phones and tablets see the switch but can't use it. The choice is saved in `settings.json`.
  - While they're off, command buttons are dimmed and refused, and none can be added, changed or imported. Existing ones can still be moved, relabeled or deleted.
  - Commands run in your home folder, with `sh -c` on Linux and `cmd.exe /c` on Windows; the OBS password is kept out of their environment.
  - On Windows, **Start an app** runs e.g. `start "" "C:\Program Files\VideoLAN\VLC\vlc.exe"` or `notepad`; a PowerShell script needs `powershell -ExecutionPolicy Bypass -File C:\path\to\script.ps1`.
- **Webhooks:**
  - A paired device can make the PC send HTTP requests to any `http://` or `https://` address, including services on your network.
  - Headers (e.g. an API token) are saved in the deck, so every paired device and every backup file can read them.
- **Open Website** opens only `http://` and `https://` addresses, in your default browser (so with your logins). Like webhooks, any paired device can add such a button.
- **Keyboard Shortcut and Type Text** buttons type into whichever window has focus, a terminal included. Keep that in mind before you pair a device you don't fully trust.
- **The HTTP API** (`/api/buttons/…`) needs the access key, like pairing does, except from the PC itself. It presses buttons that are on the deck; it can't run anything else. Requests from other websites are refused.
- **Sounds:** only MP3 and WAV files are accepted (checked by content), and only files the deck stored itself are played.

Don't forward the port to the internet. For access away from home, use your VPN (e.g. WireGuard).

## Development

```bash
npm run dev:mock    # UI + server + a fake OBS: no OBS needed (http://localhost:5173)
npm run dev         # UI + server against your real OBS
npm test            # server and shared-logic tests (node:test)
npm run typecheck   # tsc + svelte-check
```

- **What `dev:mock` runs:**
  - A mock obs-websocket server on port 4456 (`server/dev/mock-obs.ts`), with scenes, sources, audio levels and outputs.
  - Its own data directory, `.data-mock/`.
  - To simulate OBS quitting and coming back, run `kill -USR2 <pid>`, or on any system `curl http://127.0.0.1:4457/toggle`. The mock prints the command at startup.
- **Dev server and phones:** Vite serves the UI on port 5173 and proxies `/ws`, `/api`, `/icons` and `/uploads` to the Node server on 3325. The firewall blocks 5173 for other devices, so use `npm start` (port 3325) to try a phone.

### Layout

```
shared/   types, zod schemas and logic used by both sides
          (actions-meta.ts = action catalog, feedback.ts = how buttons look)
server/   Fastify HTTP + WebSocket hub, OBS bridge and state mirror, deck storage, mock OBS,
          action executors (actions/) and helpers for other programs such as playerctl (system/);
          on Windows, one PowerShell helper does their jobs (system/windows/)
web/      Svelte 5 app (deck, editor, settings)
tests/    node:test suites
deploy/   systemd user unit; for Windows a start script and the installer (windows/installer/)
.github/  CI: tests and a start-up check on Linux and Windows; building and trying the Windows installer
```

### Adding a new kind of button action

1. **Schema:** add it to `ActionSchema` in `shared/schema.ts`.
2. **Editor entry:** add an entry to `ACTION_META` in `shared/actions-meta.ts` (label, category, icon, form fields, behavior).
3. **Executor:** handle it on the server. Each `type` prefix (`obs`, `http`, …) has one executor in `server/actions/`, and `server/actions/registry.ts` lists them all. OBS actions live in `server/obs/execute.ts`.
4. **Active state (optional):** if the button should light up, add a case to `actionStatus` in `shared/feedback.ts`. State from outside OBS goes into `ExtState` (`shared/ext-types.ts`), which the server pushes to every browser.

The editor, validation and multi-device sync pick it up automatically. Executors are told which button they run for (`ActionCtx`); state kept per button (counters, timers, toggles) lives in `server/button-state.ts`. What's planned next is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Troubleshooting

- **A phone can't open the page.**
  - Check the firewall (see "Open the deck on a phone or tablet"), and that both devices are on the same network.
  - Windows: the network must be private, not public (Settings → Network & internet).
  - If `<name>.local` doesn't resolve on that phone, use the IP address instead.
- **Windows says the port can't be used:** Hyper-V and WSL reserve ranges of ports. `netsh interface ipv4 show excludedportrange protocol=tcp` lists them; set `PORT` in `.env` to a port outside them.
- **"OBS rejected the password":** copy the password again from *Show Connect Info* in OBS into Settings.
- **"Can't reach OBS":** OBS isn't running, or its WebSocket server is off (Tools → WebSocket Server Settings).
- **Media keys are dimmed (Linux):** no media player is running, or `playerctl` isn't installed. Run `playerctl -l` in a terminal: it should list your players.
- **Keyboard shortcuts do nothing (Linux):** the toast says whether `ydotool` is missing or its service isn't running. `ydotool key 29:1 29:0` in a terminal (taps Ctrl) should run without an error.
- **Type Text (Linux)** pastes with Ctrl+V, which terminals don't take (they want Ctrl+Shift+V). It also replaces what you had copied.
- **Sounds don't play (Linux):** the toast names the problem. `pw-play /path/to/sound.mp3` in a terminal should play it; the deck also tries `paplay` and `ffplay`.
- **Open Website does nothing (Linux, systemd service):** the browser needs your desktop session's variables; see "Start it automatically on login".
- **System volume buttons are dimmed (Linux):** `wpctl get-volume @DEFAULT_AUDIO_SINK@` should print the volume. If the deck runs as a systemd service, it needs to run as your user (it does with the included user unit).
- **On Windows:**
  - **Media keys are dimmed:** only players that show up in Windows' own media controls (next to the volume slider in the taskbar) can be controlled: Spotify, Chrome, Edge, Firefox and most others. VLC 3 doesn't show up there.
  - **Keyboard shortcuts don't reach a program that runs as administrator** (OBS sometimes does): Windows doesn't let normal programs type into those. Start the deck as administrator too, or use an OBS Hotkey button instead. Some games with anti-cheat ignore typed keys.
  - **"Windows PowerShell couldn't start the deck's helper":** media keys, system volume and keyboard shortcuts need it. The server log says why; `powershell -NoProfile -Command "$PSVersionTable.PSVersion"` should print 5.1. A company PC may block PowerShell scripts by policy.
  - **The CPU temperature tile says n/a:** Windows has no standard way for programs to read it.
  - **Sounds:** Windows plays MP3 and WAV through its built-in media player component (winmm), on the default speakers.
- **The tablet's screen turns off:**
  - Keep-awake needs one tap after the page loads.
  - Over plain `http://`, browsers only allow a workaround, so also consider raising the tablet's auto-lock time.
