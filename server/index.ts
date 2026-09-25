import QRCode from 'qrcode';
import { startApp } from './app.ts';
import { readEnv } from './env.ts';
import { createLogger, errorMessage } from './log.ts';
import { pairingUrl, reachableUrls } from './network.ts';

const env = readEnv();
const log = createLogger('server');

async function printBanner(key: string, obsUrl: string): Promise<void> {
  const port = env.publicPort;
  const pair = pairingUrl(port, key);
  const qr = await QRCode.toString(pair, { type: 'terminal', small: true });
  const [mdns, ...ips] = reachableUrls(port);
  console.log(
    [
      '',
      '  Virtual Stream Deck is running',
      '',
      `  This PC:        http://localhost:${port}`,
      `  Other devices:  ${mdns}`,
      ...ips.map((u) => `                  ${u}`),
      '',
      '  Pair a phone or tablet by scanning this code (it contains the access key):',
      '',
      qr.replace(/^/gm, '  '),
      `  or open ${pair}`,
      '',
      `  OBS: ${obsUrl}`,
      ...(env.commandsEnabled ? ['  Run Command buttons are ON (STREAMDECK_ENABLE_COMMANDS=1): paired devices can run programs on this PC.'] : []),
      "  Other devices can't connect? Allow the port in your firewall (see README).",
      '',
    ].join('\n'),
  );
}

/** Apps started by Run Command buttons need the desktop session's variables (e.g. under systemd). */
function checkCommandEnvironment(): void {
  if (!env.commandsEnabled || process.platform !== 'linux') return;
  const missing = [];
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) missing.push('WAYLAND_DISPLAY');
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) missing.push('DBUS_SESSION_BUS_ADDRESS');
  if (missing.length === 0) return;
  log.warn(
    `${missing.join(' and ')} not set, so apps started by Run Command buttons may not open. ` +
      `Under systemd, run: systemctl --user import-environment ${missing.join(' ')}`,
  );
}

async function main(): Promise<void> {
  let app;
  try {
    app = await startApp(env);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      log.error(`Port ${env.port} is already in use. Is another copy running? Set PORT to use a different one.`);
      process.exit(1);
    }
    if (code === 'EACCES' && process.platform === 'win32') {
      // Hyper-V and WSL reserve ranges of ports, and Windows then refuses them to everyone else.
      log.error(
        `Windows doesn't allow port ${env.port} (it may be reserved; see: netsh interface ipv4 show excludedportrange protocol=tcp). ` +
          'Set PORT to use a different one.',
      );
      process.exit(1);
    }
    throw err;
  }
  await printBanner(app.settingsStore.settings.accessKey, app.settingsStore.obsConfig(env).url);
  log.info(`Data directory: ${env.dataDir}`);
  checkCommandEnvironment();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Closing the terminal window (on Windows, the console window).
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
}

main().catch((err) => {
  log.error(`Failed to start: ${errorMessage(err)}`);
  console.error(err);
  process.exit(1);
});
