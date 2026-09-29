<script lang="ts">
  import { prefs } from '../lib/prefs.svelte.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  let message = $state('');
  let starting = $state(false);
  let checking = $state(false);

  const info = $derived(store.info!);
  const update = $derived(info.update);
  const available = $derived(update.available);
  const obs = $derived(store.obs!);
  const published = $derived(available?.publishedAt ? new Date(available.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
  const canInstall = $derived(store.local && update.packaging !== 'source' && !!available?.installable && update.state === 'idle');
  // What the PC's own browser opens: the same port this device uses (Vite's in development).
  const pcAddress = `http://localhost:${location.port || '80'}`;

  async function install(): Promise<void> {
    const streaming = obs.stream.state === 'started' || obs.stream.state === 'reconnecting';
    const recording = obs.record.state === 'started';
    if (
      (streaming || recording) &&
      !confirm(`OBS is ${streaming ? 'streaming' : 'recording'}. The deck is gone for a few seconds while it restarts; OBS keeps going. Update now?`)
    ) {
      return;
    }
    starting = true;
    message = '';
    try {
      await store.request({ t: 'update', action: 'install' });
    } catch (err) {
      message = (err as Error).message;
    } finally {
      starting = false;
    }
  }

  async function check(): Promise<void> {
    checking = true;
    message = '';
    try {
      await store.request({ t: 'update', action: 'check' });
    } catch (err) {
      message = (err as Error).message;
    } finally {
      checking = false;
    }
  }

  function later(): void {
    if (available) prefs.skippedUpdate = available.version;
    close();
  }

  const close = () => (store.updateOpen = false);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Update HoudiniDeck">
    <header>
      <h2>{available ? `HoudiniDeck ${available.version}` : 'Updates'}</h2>
      <button class="icon-btn" aria-label="Close" onclick={close}><UiIcon name="close" /></button>
    </header>
    <div class="body">
      {#if available}
        <p class="lead">
          A new version is out{published ? ` (${published})` : ''}. This deck runs {info.version}.
        </p>
        {#if available.notes}<pre class="notes">{available.notes}</pre>{/if}
        <p><a href={available.pageUrl} target="_blank" rel="noreferrer">Release notes on GitHub <UiIcon name="open-in-new" size={15} /></a></p>
      {:else if update.checkedAt && !update.error}
        <p class="lead">HoudiniDeck {info.version} is the newest version.</p>
      {:else}
        <p class="lead">This deck runs HoudiniDeck {info.version}.</p>
      {/if}

      {#if update.state === 'downloading'}
        <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor((update.progress ?? 0) * 100)}>
          <span style:width="{(update.progress ?? 0) * 100}%"></span>
        </div>
        <p class="hint">Downloading {available?.version}… {Math.floor((update.progress ?? 0) * 100)}%</p>
      {:else if update.state === 'installing'}
        <p class="status"><UiIcon name="progress-download" size={18} /> Installing… Windows may ask on the PC whether HoudiniDeck may make changes: click Yes. The deck then restarts by itself.</p>
      {:else if update.state === 'restarting'}
        <p class="status"><UiIcon name="restart" size={18} /> Restarting… this page reconnects by itself.</p>
      {:else if available}
        {#if update.packaging === 'source'}
          <p class="hint">This deck runs from its source code. To update it, stop it (Ctrl+C) and run this in its folder:</p>
          <pre class="commands">git pull
npm install
npm run build
npm start</pre>
          <p class="hint">With the systemd service, run <code>systemctl --user restart virtual-streamdeck</code> instead of <code>npm start</code>.</p>
        {:else if !available.installable}
          <p class="hint">The download for this PC isn’t attached to the release yet (that takes a few minutes after it’s published). Check again soon.</p>
        {:else if !store.local}
          <p class="hint">To update, open the deck in the browser on the PC itself: {pcAddress}</p>
        {:else}
          <p class="hint">
            {update.packaging === 'windows-installer'
              ? 'Update now downloads the new installer and runs it. Windows asks once for permission, then the deck restarts by itself.'
              : 'Update now downloads the new AppImage, puts it in place of this one and restarts the deck.'}
            Your deck, settings and images stay. Open phones and tablets reconnect by themselves.
          </p>
        {/if}
      {/if}

      {#if update.error}<p class="error">{update.error}</p>{/if}
      {#if message}<p class="error">{message}</p>{/if}
    </div>
    <footer>
      {#if available && !store.updating}
        <button class="btn ghost" onclick={later}>Not now</button>
      {/if}
      <span class="spacer"></span>
      <button class="btn" disabled={checking || store.updating || update.checks === 'env-off'} onclick={check}>
        <UiIcon name="refresh" size={18} />{checking ? 'Checking…' : 'Check again'}
      </button>
      {#if canInstall}
        <button class="btn primary" disabled={starting} onclick={install}><UiIcon name="download" size={18} /> Update now</button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .body p {
    margin: 0;
  }
  .lead {
    font-size: 1rem;
  }
  pre {
    margin: 0;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    font: 0.85rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow: auto;
  }
  .notes {
    max-height: 240px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--muted);
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
  }
  .status {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .progress {
    height: 8px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-3);
  }
  .progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.25s linear;
  }
</style>
