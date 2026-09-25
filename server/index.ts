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
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log.error(`Port ${env.port} is already in use. Is another copy running? Set PORT to use a different one.`);
      process.exit(1);
    }
    throw err;
  }
  await printBanner(app.settingsStore.settings.accessKey, app.settingsStore.obsConfig(env).url);
  log.info(`Data directory: ${env.dataDir}`);

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
}

main().catch((err) => {
  log.error(`Failed to start: ${errorMessage(err)}`);
  console.error(err);
  process.exit(1);
});
