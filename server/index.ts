import QRCode from 'qrcode';
import { startApp } from './app.ts';
import { readEnv } from './env.ts';
import { createLogger, errorMessage } from './log.ts';
import { deckRunningOn, openInBrowser, pairingUrl, reachableUrls } from './network.ts';
import { desktopSessionWarning } from './system/command.ts';

const env = readEnv();
const log = createLogger('server');

async function printBanner(key: string, obsUrl: string, commands: boolean): Promise<void> {
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
      ...(commands ? ['  Run Command buttons are ON (Settings): paired devices can run programs on this PC.'] : []),
      "  Other devices can't connect? Allow the port in your firewall (see README).",
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  let app;
  try {
    app = await startApp(env);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      // Started from a shortcut while it already runs (e.g. since login): just show that one.
      if (env.openBrowser && (await deckRunningOn(env.port))) {
        log.info(`The deck is already running; opening http://localhost:${env.publicPort}`);
        openInBrowser(`http://localhost:${env.publicPort}`);
        process.exit(0);
      }
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
  const { settings } = app.settingsStore;
  await printBanner(settings.accessKey, app.settingsStore.obsConfig(env).url, settings.commands);
  log.info(`Data directory: ${env.dataDir}`);
  const sessionWarning = settings.commands && desktopSessionWarning();
  if (sessionWarning) log.warn(sessionWarning);
  if (process.env.STREAMDECK_ENABLE_COMMANDS !== undefined) {
    log.warn('STREAMDECK_ENABLE_COMMANDS is no longer used; remove it from .env. Run Command buttons are now turned on in Settings, in the browser on this PC.');
  }
  if (env.openBrowser) openInBrowser(`http://localhost:${env.publicPort}`);

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
