import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { startApp, type App } from './app.ts';
import { readEnv } from './env.ts';
import { createLogger, errorMessage } from './log.ts';
import { deckRunningOn, openInBrowser, pairingUrl, reachableUrls } from './network.ts';
import { desktopSessionWarning } from './system/command.ts';
import type { Relaunch } from './update/install.ts';

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

/** Start the new version (after an update) on its own, not as a child of this process. */
function launchDetached(next: Relaunch): Promise<void> {
  return new Promise((resolve) => {
    log.info(`Starting ${next.command} ${next.args.join(' ')}`);
    spawn(next.command, next.args, { detached: true, stdio: 'ignore', env: next.env })
      .once('spawn', resolve)
      .once('error', (err) => {
        log.error(`Couldn't start ${next.command}: ${errorMessage(err)}. Start it by hand.`);
        resolve();
      })
      .unref();
  });
}

async function main(): Promise<void> {
  let app: App | undefined;
  let stopping = false;
  /** Close the deck (it tells connected browsers first); after an update, start the new version in its place. */
  const shutdown = async (reason: string, next?: Relaunch) => {
    if (stopping || !app) return;
    stopping = true;
    log.info(`${reason}, shutting down`);
    await app.close();
    if (next) await launchDetached(next);
    process.exit(0);
  };
  try {
    app = await startApp(env, { relaunch: (next) => void shutdown('Updated', next) });
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

  process.on('SIGINT', () => void shutdown('SIGINT received'));
  process.on('SIGTERM', () => void shutdown('SIGTERM received'));
  // Closing the terminal window (on Windows, the console window).
  process.on('SIGHUP', () => void shutdown('SIGHUP received'));
}

main().catch((err) => {
  log.error(`Failed to start: ${errorMessage(err)}`);
  console.error(err);
  process.exit(1);
});
