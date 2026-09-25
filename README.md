# Virtual Stream Deck

A self-hosted Stream Deck for OBS that runs in the browser. It runs on the PC with OBS; open it on a tablet, phone or laptop on the same network, and every device stays in sync.

- **OBS control:**
  - Scenes, with Program/Preview highlighting in Studio Mode.
  - Source visibility and filters.
  - Mute, push-to-talk/push-to-mute, and volume faders with live meters.
  - Stream, record (pause, split, chapters), replay buffer and virtual camera.
  - Transitions, screenshots, scene collections and profiles, OBS hotkeys, and media sources.
- **Beyond OBS:**
  - Media keys for music and videos on the PC (Spotify, browsers, VLC, …), optionally showing the song and its cover art.
  - The PC's own volume: mute or step the default speakers or microphone, or drag a fader.
- **Macros:** one button runs several actions in a row, with pauses, e.g. switch scene, unmute the mic, start recording.
  - Webhook buttons that send an HTTP request, e.g. to Home Assistant, Streamer.bot or a Philips Hue bridge.
- **A real deck:**
  - Any grid size, several pages, and folders.
  - Drag-and-drop editing.
  - Icons (Material Design and brand logos), uploaded images, emoji and colors.
  - A separate look while a button is active, long-press actions, and "tap twice" protection for Stream.
- **Built for touch:**
  - Buttons fire on touch-down, and hold-to-talk works.
  - Compact mode, fullscreen or Add to Home Screen, and keep-the-screen-on.
- **Survives restarts:** buttons are remembered by OBS's internal IDs, so renaming a scene in OBS doesn't break them. The deck reconnects on its own when OBS restarts, and a tablet reloads by itself after an update.

## Requirements

- Node.js 24.2 or newer. Node runs the TypeScript server directly, so there's no build step for the server.
- OBS Studio 28 or newer, which has obs-websocket 5 built in.
- Optional: `playerctl`, for the media keys (`sudo pacman -S playerctl`). The system volume buttons use `wpctl`, which comes with PipeWire (WirePlumber).

## Quick start

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3325> on the PC. The terminal prints the addresses for your other devices and a QR code for pairing them.

### 1. Turn on OBS's WebSocket server

1. In OBS, open **Tools → WebSocket Server Settings** and tick **Enable WebSocket server**. Keep authentication on.
2. Click **Show Connect Info** and copy the password.
3. On the deck, open **Settings** (the ⚙ in the top bar), paste the password under *OBS connection*, and click **Save and connect**.

On an empty page, **Generate from OBS** creates buttons for your scenes, audio inputs and outputs.

### 2. Open the deck on a phone or tablet

Phones and tablets need an access key (see [Security](#security)).

1. **Allow the port through the firewall.** CachyOS ships with ufw enabled; allow your LAN (adjust the subnet if yours differs):

   ```bash
   sudo ufw allow from 192.168.1.0/24 to any port 3325 proto tcp comment 'Virtual Stream Deck'
   ```

   To use the deck over your WireGuard tunnel too, add the same rule for `10.8.0.0/24`.
2. **Pair the device.** Scan the QR code in the server's terminal with its camera, or scan it from **Settings → Pair a phone or tablet** on a device that's already paired. The address is `http://my-pc.local:3325`, or the IP printed at startup.
3. **Optional:** add it to the home screen (iPhone/iPad: Share → Add to Home Screen; Android: ⋮ → Add to Home screen) so it opens fullscreen.

### Using the deck

- Each device remembers its own page. Switch pages with the tabs at the top, or with **Open Page / Folder** buttons.
- **✎ (Edit)** enters edit mode:
  - Tap **+** to add a button, and tap a button to edit it.
  - Drag a button to move it, or drop it on a page tab to move it to that page. On touch screens, hold for a moment and then drag.
  - **Pages** adds, renames, resizes and reorders pages.
- **Volume faders:** drag up or down to change the volume, tap to mute.
- **Push-to-talk buttons** unmute only while you hold them. If the device drops off the network mid-press, the server mutes again.

## Configuration

Everything can be set from the UI. These environment variables, optionally in a `.env` file (see `.env.example`), override it:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3325` | Port the deck listens on |
| `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` = this PC only) |
| `OBS_URL` | `ws://127.0.0.1:4455` | obs-websocket address |
| `OBS_PASSWORD` | – | obs-websocket password. When `OBS_URL`/`OBS_PASSWORD` are set, Settings can't change the connection |
| `STREAMDECK_DATA_DIR` | `./data` | Where the deck, settings and images are stored |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

### Data and backups

```
data/
  deck.json        pages and buttons
  settings.json    OBS connection + access key (file mode 0600)
  uploads/         button images
  backups/         older deck.json versions (automatic, last 20)
```

**Settings → Backup** can also export and import the whole deck as a JSON file. A deck file that can't be read is renamed to `deck.json.corrupt-<time>` rather than overwritten.

### Start it automatically on login (optional)

A systemd user unit is included. It assumes the project lives in `~/HoudiniDeck`; edit `WorkingDirectory` if not.

```bash
npm run build
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/deploy/virtual-streamdeck.service" ~/.config/systemd/user/virtual-streamdeck.service
systemctl --user daemon-reload
systemctl --user enable --now virtual-streamdeck.service
```

Read the logs with `journalctl --user -u virtual-streamdeck -f`. After updating the code, run `npm run build` and `systemctl --user restart virtual-streamdeck`. Open tablets reload by themselves.

## Security

The deck controls your stream, so it's locked down even on a home network:

- **Pairing:**
  - A device must present the **access key**. The QR code and the pairing link carry it in the URL fragment (`#k=…`), which browsers never send to the server.
  - The key is kept in the device's browser storage, never in a cookie. That way other websites can't use a paired browser to press buttons (no CSRF, no DNS-rebinding tricks).
  - **Settings → New key** logs out every other device.
- **The PC itself needs no key,** but only when the request both arrives over loopback and is addressed to `localhost`/`127.0.0.1`.
- **Other websites are refused:** WebSocket connections and uploads from a different origin are rejected.
- **Secrets stay on the server:** the OBS password is never sent to browsers, and `settings.json` is readable only by you.
- **Uploads:** only real images are accepted (checked by content), and they're served with `nosniff` and a sandboxing CSP.
- **Webhooks:**
  - A paired device can make the PC send HTTP requests to any `http://` or `https://` address, including services on your network.
  - Headers (e.g. an API token) are saved in the deck, so every paired device and every backup file can read them.

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
  - To simulate OBS quitting and coming back, run `kill -USR2 <pid>`. The mock prints the command at startup.
- **Dev server and phones:** Vite serves the UI on port 5173 and proxies `/ws`, `/api`, `/icons` and `/uploads` to the Node server on 3325. The firewall blocks 5173 for other devices, so use `npm start` (port 3325) to try a phone.

### Layout

```
shared/   types, zod schemas and logic used by both sides
          (actions-meta.ts = action catalog, feedback.ts = how buttons look)
server/   Fastify HTTP + WebSocket hub, OBS bridge and state mirror, deck storage, mock OBS,
          action executors (actions/) and helpers for other programs such as playerctl (system/)
web/      Svelte 5 app (deck, editor, settings)
tests/    node:test suites
deploy/   systemd user unit
```

### Adding a new kind of button action

1. **Schema:** add it to `ActionSchema` in `shared/schema.ts`.
2. **Editor entry:** add an entry to `ACTION_META` in `shared/actions-meta.ts` (label, category, icon, form fields, behavior).
3. **Executor:** handle it on the server. Each `type` prefix (`obs`, `http`, …) has one executor in `server/actions/`, and `server/actions/registry.ts` lists them all. OBS actions live in `server/obs/execute.ts`.
4. **Active state (optional):** if the button should light up, add a case to `actionStatus` in `shared/feedback.ts`. State from outside OBS goes into `ExtState` (`shared/ext-types.ts`), which the server pushes to every browser.

The editor, validation and multi-device sync pick it up automatically. What's planned next (Phase 3: shell commands, stats tile, hotkeys, Discord mute) is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Troubleshooting

- **A phone can't open the page.**
  - Check the ufw rule above, and that both devices are on the same network.
  - If `my-pc.local` doesn't resolve on that phone, use the IP address instead.
- **"OBS rejected the password":** copy the password again from *Show Connect Info* in OBS into Settings.
- **"Can't reach OBS":** OBS isn't running, or its WebSocket server is off (Tools → WebSocket Server Settings).
- **Media keys are dimmed:** no media player is running, or `playerctl` isn't installed. Run `playerctl -l` in a terminal: it should list your players.
- **System volume buttons are dimmed:** `wpctl get-volume @DEFAULT_AUDIO_SINK@` should print the volume. If the deck runs as a systemd service, it needs to run as your user (it does with the included user unit).
- **The tablet's screen turns off:**
  - Keep-awake needs one tap after the page loads.
  - Over plain `http://`, browsers only allow a workaround, so also consider raising the tablet's auto-lock time.
