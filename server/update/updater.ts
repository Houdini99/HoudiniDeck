// Finds new releases on GitHub and installs them (docs/ROADMAP.md, "Updates"). Every browser hears about
// a new version through ServerInfo.update; only the PC's own browser may install it (the hub checks).
import { EventEmitter } from 'node:events';
import { access, chmod, constants, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { AvailableUpdate, Packaging, UpdateInfo } from '../../shared/protocol.ts';
import { fetchFailure } from '../actions/http.ts';
import { OpError } from '../deck/ops.ts';
import { errorMessage, type Logger } from '../log.ts';
import { downloadVerified, installerArgs, relaunchEnv, runInstaller, type InstallerRunner, type Relaunch } from './install.ts';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 12 * 60 * 60_000;
/** After a failed check, or while a new release's download isn't attached yet (CI takes a few minutes). */
const RECHECK_SOON_MS = 30 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;
const PROGRESS_EVERY_MS = 250;
const NOTES_MAX = 4000;
/** How long browsers get to hear "restarting" before the deck closes. */
const RESTART_DELAY_MS = 300;
/** The installer stops this deck; if it is still running this long after the installer ended, something went wrong. */
const INSTALLER_GRACE_MS = 3 * 60_000;
/** Inno Setup's exit code for "cancelled before installing": in a silent update, No at Windows' permission prompt. */
const INSTALLER_CANCELLED = 2;

export const APPIMAGE_ASSET = 'HoudiniDeck-x86_64.AppImage';
/** The new AppImage while it downloads: next to the running one, so it can be renamed over it. */
export const APPIMAGE_PART = '.HoudiniDeck-update.part';

const HttpUrl = z.url({ protocol: /^https?$/ });

const ReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: HttpUrl,
  body: z.string().nullish(),
  published_at: z.string().nullish(),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().int().nonnegative(),
      browser_download_url: HttpUrl,
      /** "sha256:<hex>" (GitHub computes it for every asset). */
      digest: z.string().nullish(),
    }),
  ),
});
type Release = z.infer<typeof ReleaseSchema>;

/** -1, 0 or 1 for x.y.z versions (a leading v is fine); undefined when either isn't one. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The release file this copy updates itself with (the names CI gives them); none for a source checkout. */
export function assetName(packaging: Packaging, version: string): string | undefined {
  if (packaging === 'appimage') return APPIMAGE_ASSET;
  if (packaging === 'windows-installer') return `HoudiniDeck-Setup-${version}.exe`;
  return undefined;
}

/** Release notes as plain text: GitHub's generated notes carry an HTML comment, and some are long. */
function plainNotes(body: string | null | undefined): string {
  const text = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  return text.length > NOTES_MAX ? `${text.slice(0, NOTES_MAX).trimEnd()}…` : text;
}

interface Download {
  version: string;
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface UpdaterDeps {
  /** The running version. */
  version: string;
  packaging: Packaging;
  appImagePath?: string;
  /** Where the newest release is described (GitHub's API); undefined: no checks at all. */
  feed?: string;
  dataDir: string;
  /** Whether to check by itself (settings.checkUpdates). */
  autoCheck: () => boolean;
  /** Close this deck and start `next` in its place. */
  relaunch: (next: Relaunch) => void;
  /** Saves what must survive (button states) before the Windows installer stops the deck. */
  beforeInstall?: () => Promise<void>;
  fetch?: typeof fetch;
  runInstaller?: InstallerRunner;
  log: Logger;
}

export class Updater extends EventEmitter<{ change: [] }> {
  private state: UpdateInfo['state'] = 'idle';
  private available?: AvailableUpdate;
  private download?: Download;
  private progress?: number;
  private error?: string;
  private checkedAt?: number;
  private etag?: string;
  private checking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private lastProgressAt = 0;
  private announced?: string;
  private readonly deps: UpdaterDeps;

  constructor(deps: UpdaterDeps) {
    super();
    this.deps = deps;
    if (deps.packaging === 'appimage' && !deps.appImagePath) deps.log.warn("APPIMAGE isn't set, so updates can't replace the AppImage");
  }

  get info(): UpdateInfo {
    return {
      packaging: this.deps.packaging,
      available: this.available,
      state: this.state,
      progress: this.progress,
      error: this.error,
      checkedAt: this.checkedAt,
      checks: !this.deps.feed ? 'env-off' : this.deps.autoCheck() ? 'on' : 'off',
    };
  }

  /** The first check comes a little after start-up, then twice a day (while turned on in Settings). */
  start(): void {
    void this.cleanUp();
    if (this.deps.feed) this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Settings turned automatic checks on or off. */
  autoChanged(): void {
    this.emit('change');
    const stale = !this.checkedAt || Date.now() - this.checkedAt > CHECK_EVERY_MS;
    if (this.deps.feed && this.deps.autoCheck() && stale) void this.check();
  }

  /** Ask GitHub now. A failed check shows up as `error`; this only throws when checks are off on the server. */
  async check(): Promise<UpdateInfo> {
    if (!this.deps.feed) throw new OpError('Update checks are turned off on the server (STREAMDECK_UPDATE_CHECK=0).');
    this.checking ??= this.fetchRelease().finally(() => (this.checking = undefined));
    await this.checking;
    return this.info;
  }

  /** Start downloading and installing the version found. Returns once it has started; progress comes as changes. */
  async install(): Promise<void> {
    if (this.deps.packaging === 'source') {
      throw new OpError('This copy runs from its source code: update it with git pull, npm install and npm run build, then restart it.');
    }
    if (this.state === 'checking') throw new OpError('Still looking for updates; try again in a moment.');
    if (this.state !== 'idle') throw new OpError('The update is already running.');
    const download = this.download;
    if (!download) {
      throw new OpError(
        this.available ? `The download for ${this.available.version} isn't ready yet; try again in a few minutes.` : 'There is no update to install.',
      );
    }
    this.set({ state: 'downloading', progress: 0, error: undefined });
    this.deps.log.info(`Updating to ${download.version}`);
    const run = this.deps.packaging === 'appimage' ? this.replaceAppImage(download) : this.runWindowsInstaller(download);
    run.catch((err) => {
      this.deps.log.warn(`The update to ${download.version} failed: ${errorMessage(err)}`);
      this.set({ state: 'idle', progress: undefined, error: errorMessage(err) });
    });
  }

  private set(changes: Partial<Pick<UpdateInfo, 'state' | 'progress' | 'error'>>): void {
    if ('state' in changes) this.state = changes.state!;
    if ('progress' in changes) this.progress = changes.progress;
    if ('error' in changes) this.error = changes.error;
    this.emit('change');
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scheduledCheck(), ms);
    this.timer.unref();
  }

  private async scheduledCheck(): Promise<void> {
    if (this.deps.autoCheck()) await this.check();
    const soon = this.deps.autoCheck() && (this.error !== undefined || this.available?.installable === false);
    this.schedule(soon ? RECHECK_SOON_MS : CHECK_EVERY_MS);
  }

  private async fetchRelease(): Promise<void> {
    // While an update runs, what it installs is settled.
    if (this.state !== 'idle') return;
    this.set({ state: 'checking' });
    let error: string | undefined;
    try {
      const release = await this.request(this.deps.feed!);
      if (release !== 'unchanged') this.found(release);
    } catch (err) {
      error = `Couldn't check for updates: ${errorMessage(err)}`;
      this.deps.log.debug(error);
    }
    this.checkedAt = Date.now();
    this.set({ state: 'idle', error });
  }

  /** The newest release, 'unchanged' since the last answer, or undefined when there is none. */
  private async request(feed: string): Promise<Release | 'unchanged' | undefined> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': `HoudiniDeck/${this.deps.version}`,
      'x-github-api-version': '2022-11-28',
    };
    // Answers "not modified" don't count against GitHub's limit of 60 requests an hour.
    if (this.etag) headers['if-none-match'] = this.etag;
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(feed, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(fetchFailure(err, new URL(feed), CHECK_TIMEOUT_MS));
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return 'unchanged';
    }
    if (res.status === 404) return undefined; // nothing published yet
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests from this network; try again later');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const parsed = ReleaseSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new Error("GitHub's answer isn't what the deck expected");
    this.etag = res.headers.get('etag') ?? undefined;
    return parsed.data;
  }

  private found(release: Release | undefined): void {
    const { version, packaging, log } = this.deps;
    const latest = release?.tag_name.replace(/^v/, '') ?? '';
    if (!release || compareVersions(latest, version) !== 1) {
      this.available = undefined;
      this.download = undefined;
      return;
    }
    const name = assetName(packaging, latest);
    const asset = name ? release.assets.find((a) => a.name === name) : undefined;
    const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')?.[1];
    this.download = asset && sha256 ? { version: latest, name: asset.name, url: asset.browser_download_url, sha256, size: asset.size } : undefined;
    this.available = {
      version: latest,
      pageUrl: release.html_url,
      notes: plainNotes(release.body),
      publishedAt: release.published_at ?? undefined,
      installable: this.download !== undefined,
    };
    if (this.announced !== latest) {
      this.announced = latest;
      log.info(`Version ${latest} is available: ${release.html_url}`);
    }
  }

  private onProgress(share: number): void {
    const now = Date.now();
    if (share < 1 && now - this.lastProgressAt < PROGRESS_EVERY_MS) return;
    this.lastProgressAt = now;
    this.set({ progress: share });
  }

  /** The running AppImage keeps its open file, so the new one can simply take its name; then it starts in this one's place. */
  private async replaceAppImage(download: Download): Promise<void> {
    const target = this.deps.appImagePath;
    if (!target) throw new Error("Can't tell which AppImage file this deck runs from (APPIMAGE isn't set)");
    const dir = dirname(target);
    try {
      await access(dir, constants.W_OK);
    } catch {
      throw new Error(`Can't replace ${target}: its folder isn't writable. Download the new version from its release page instead.`);
    }
    const part = join(dir, APPIMAGE_PART);
    await downloadVerified(download.url, part, download, (share) => this.onProgress(share), this.deps.fetch);
    try {
      await chmod(part, 0o755);
      await rename(part, target);
    } catch (err) {
      await rm(part, { force: true });
      throw new Error(`Couldn't replace ${target}: ${errorMessage(err)}`);
    }
    this.deps.log.info(`${target} is now version ${download.version}; restarting`);
    this.set({ state: 'restarting', progress: undefined });
    await delay(RESTART_DELAY_MS);
    this.deps.relaunch({ command: target, args: ['--no-browser'], env: relaunchEnv(process.env) });
  }

  /** The installer stops this deck (stop-deck.ps1), installs, and starts the new one (/STARTDECK). */
  private async runWindowsInstaller(download: Download): Promise<void> {
    const dir = join(this.deps.dataDir, 'updates');
    await mkdir(dir, { recursive: true });
    const setup = join(dir, download.name);
    await downloadVerified(download.url, setup, download, (share) => this.onProgress(share), this.deps.fetch);
    this.set({ state: 'installing', progress: undefined });
    await this.deps.beforeInstall?.();
    const logFile = join(dir, 'install.log');
    this.deps.log.info(`Starting the installer for ${download.version}; it stops this deck and starts the new one`);
    const code = await (this.deps.runInstaller ?? runInstaller)(setup, installerArgs(logFile));
    // Still running: the installer ended without stopping this deck.
    if (code === INSTALLER_CANCELLED) throw new Error("The update was cancelled at Windows' permission prompt. Press Update now to try again.");
    if (code !== 0) throw new Error(`The update failed (installer exit code ${code}). Its log: ${logFile}`);
    await delay(INSTALLER_GRACE_MS, undefined, { ref: false });
    throw new Error('The installer finished, but this deck still runs the old version. Restart HoudiniDeck.');
  }

  /** Left over from an earlier update: the installer that ran, or a download that was cut off. */
  private async cleanUp(): Promise<void> {
    const dir = join(this.deps.dataDir, 'updates');
    const files = await readdir(dir).catch(() => [] as string[]);
    const stale = files.filter((f) => f.endsWith('.exe')).map((f) => join(dir, f));
    if (this.deps.appImagePath) stale.push(join(dirname(this.deps.appImagePath), APPIMAGE_PART));
    // The installer may still be finishing (it started this deck); then it goes next time.
    await Promise.all(stale.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}
