<script lang="ts">
  import { onMount } from 'svelte';
  import type { SettingsView } from '$shared/protocol.ts';
  import { canFullscreen, toggleFullscreen } from '../lib/device.ts';
  import { setKey } from '../lib/key.ts';
  import { prefs } from '../lib/prefs.svelte.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  let view = $state<SettingsView | null>(null);
  let loadError = $state('');
  let url = $state('');
  let password = $state('');
  let busy = $state(false);
  let obsMessage = $state('');
  let copied = $state(false);

  const obs = $derived(store.obs!);
  const deck = $derived(store.deck!);
  const vibrates = typeof navigator.vibrate === 'function';

  onMount(async () => {
    try {
      view = await store.request<SettingsView>({ t: 'settings', action: 'get' });
      url = view.obs.url;
    } catch (err) {
      loadError = (err as Error).message;
    }
  });

  async function saveObs(newPassword: string | undefined): Promise<void> {
    busy = true;
    obsMessage = '';
    try {
      view = await store.request<SettingsView>({ t: 'settings.obs', url: url.trim(), password: newPassword });
      password = '';
      obsMessage = 'Saved. Connecting to OBS…';
    } catch (err) {
      obsMessage = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function reconnect(): Promise<void> {
    obsMessage = '';
    await store.request({ t: 'settings', action: 'reconnectObs' }).catch((err: Error) => (obsMessage = err.message));
  }

  async function rotateKey(): Promise<void> {
    if (!confirm('Create a new access key? Every other paired phone or tablet is disconnected and has to scan the new code.')) return;
    try {
      const result = await store.request<SettingsView & { key: string }>({ t: 'settings', action: 'rotateKey' });
      setKey(result.key);
      view = result;
      store.toast('New access key created. Pair your other devices again.');
    } catch (err) {
      store.toast((err as Error).message, 'error');
    }
  }

  async function copyLink(input: HTMLInputElement): Promise<void> {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.pairing.url);
    } catch {
      // Clipboard API needs https or localhost; fall back to selecting the text.
      input.select();
      document.execCommand('copy');
    }
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  function exportDeck(): void {
    const blob = new Blob([JSON.stringify(deck, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stream-deck-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importDeck(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      store.toast('That file is not a deck export (not JSON).', 'error');
      return;
    }
    if (!confirm('Replace the whole deck with this file? The current deck is backed up on the server first.')) return;
    await store.op({ op: 'deck.import', deck: data }).then(() => store.toast('Deck imported'), () => {});
  }

  const close = () => (store.settingsOpen = false);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Settings">
    <header>
      <h2>Settings</h2>
      <button class="icon-btn" aria-label="Close" onclick={close}><UiIcon name="close" /></button>
    </header>
    <div class="body">
      {#if loadError}<p class="error">{loadError}</p>{/if}

      <section class="group">
        <h3 class="section-title">OBS connection</h3>
        <p class="status {obs.connection}">
          <span class="dot"></span>
          {#if obs.connection === 'connected'}
            Connected to OBS {obs.version?.obs} (obs-websocket {obs.version?.websocket})
          {:else if obs.connection === 'connecting'}
            Connecting to {obs.url ?? 'OBS'}…
          {:else}
            {obs.error ?? 'Not connected'}
          {/if}
        </p>
        {#if view?.obs.fromEnv}
          <p class="hint">The connection is set with OBS_URL / OBS_PASSWORD on the server (e.g. in .env), so it can’t be changed here.</p>
        {/if}
        <form
          class="group"
          onsubmit={(e) => {
            e.preventDefault();
            void saveObs(password || undefined);
          }}
        >
          <label class="field">
            <span>WebSocket address</span>
            <input type="url" bind:value={url} disabled={!view || view.obs.fromEnv} placeholder="ws://127.0.0.1:4455" />
          </label>
          <label class="field">
            <span>Password</span>
            <input
              type="password"
              bind:value={password}
              autocomplete="off"
              disabled={!view || view.obs.fromEnv}
              placeholder={view?.obs.hasPassword ? 'Saved (leave empty to keep it)' : 'No password saved'}
            />
          </label>
          {#if view && url.trim() !== view.obs.url && view.obs.hasPassword && !password}
            <p class="hint">A new address needs the password again (the saved one is only used for {view.obs.url}).</p>
          {/if}
          <p class="hint">In OBS: Tools → WebSocket Server Settings → enable the server, then “Show Connect Info” for the password.</p>
          <div class="row">
            <button class="btn primary" type="submit" disabled={busy || !view || view.obs.fromEnv}>Save and connect</button>
            <button class="btn" type="button" onclick={reconnect}>Reconnect now</button>
            {#if view?.obs.hasPassword && !view.obs.fromEnv}
              <button class="btn ghost" type="button" disabled={busy} onclick={() => saveObs('')}>Remove password</button>
            {/if}
          </div>
          {#if obsMessage}<p class="hint">{obsMessage}</p>{/if}
        </form>
      </section>

      <section class="group">
        <h3 class="section-title">Pair a phone or tablet</h3>
        {#if view}
          <div class="pairing">
            <div class="qr">{@html view.pairing.qrSvg}</div>
            <div class="group">
              <p class="hint">Scan this code with the other device’s camera, or open the link there. It contains the access key, so only show it to devices you trust.</p>
              <div class="row">
                <input type="text" readonly value={view.pairing.url} aria-label="Pairing link" onfocus={(e) => e.currentTarget.select()} />
              </div>
              <div class="row">
                <button class="btn" onclick={(e) => copyLink((e.currentTarget.closest('.group') as HTMLElement).querySelector('input')!)}>
                  <UiIcon name="content-copy" size={18} />{copied ? 'Copied' : 'Copy link'}
                </button>
                <button class="btn danger" onclick={rotateKey}><UiIcon name="key-variant" size={18} /> New key</button>
              </div>
            </div>
          </div>
        {:else}
          <p class="hint">Loading…</p>
        {/if}
      </section>

      <section class="group">
        <h3 class="section-title">This device</h3>
        <label class="field">
          <span>Open on</span>
          <select bind:value={prefs.startPage}>
            <option value="">The page I used last</option>
            {#each deck.pages as page (page.id)}<option value={page.id}>{page.name}</option>{/each}
          </select>
        </label>
        <label class="toggle">
          <span>Compact mode<small>Hides the top bar (tap ⋯ to show it) and tightens spacing.</small></span>
          <input type="checkbox" bind:checked={prefs.compact} />
        </label>
        <label class="toggle">
          <span>Show button labels</span>
          <input type="checkbox" bind:checked={prefs.showLabels} />
        </label>
        {#if vibrates}
          <label class="toggle">
            <span>Vibrate on press</span>
            <input type="checkbox" bind:checked={prefs.haptics} />
          </label>
        {/if}
        <label class="toggle">
          <span>Keep the screen on<small>Starts after your next tap. Best effort over plain http.</small></span>
          <input type="checkbox" bind:checked={prefs.keepAwake} />
        </label>
        <label class="field">
          <span>Dim the screen when not used for</span>
          <select bind:value={prefs.dimAfterMin}>
            <option value={0}>Never</option>
            {#each [1, 2, 5, 10, 15, 30, 60] as minutes (minutes)}
              <option value={minutes}>{minutes} minute{minutes === 1 ? '' : 's'}</option>
            {/each}
          </select>
          <small class="hint">A dark screen with a faint clock, for tablets that stay on. The tap that wakes it doesn’t press a button.</small>
        </label>
        {#if canFullscreen()}
          <div><button class="btn" onclick={toggleFullscreen}><UiIcon name="fullscreen" size={18} /> Toggle fullscreen</button></div>
        {:else}
          <p class="hint">For fullscreen on iPhone/iPad, use Share → Add to Home Screen and open the deck from there.</p>
        {/if}
      </section>

      <section class="group">
        <h3 class="section-title">Backup</h3>
        <div class="row">
          <button class="btn" onclick={exportDeck}><UiIcon name="download" size={18} /> Export deck</button>
          <label class="btn file">
            <UiIcon name="upload" size={18} /> Import deck…
            <input type="file" accept="application/json,.json" onchange={importDeck} />
          </label>
        </div>
        <p class="hint">The server also keeps automatic backups in data/backups/.</p>
      </section>

      <section class="group about">
        <h3 class="section-title">About</h3>
        <p class="hint">
          Virtual Stream Deck {store.info?.version} on {store.info?.hostname} · deck revision {deck.revision}
        </p>
        {#if store.info?.urls.length}
          <p class="hint">Reachable at {store.info.urls.join(' · ')}</p>
        {/if}
      </section>
    </div>
  </div>
</div>

<style>
  .group {
    display: grid;
    gap: 12px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }
  .status.disconnected,
  .status.auth-failed {
    color: var(--danger-text);
  }
  .dot {
    width: 10px;
    height: 10px;
    flex: none;
    border-radius: 50%;
    background: var(--danger);
  }
  .connected .dot {
    background: var(--ok);
  }
  .connecting .dot {
    background: var(--warn);
  }
  .pairing {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 18px;
  }
  .pairing > .group {
    flex: 1 1 240px;
  }
  .qr {
    width: 180px;
    padding: 8px;
    flex: none;
    border-radius: 12px;
    background: #fff;
  }
  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .file {
    position: relative;
  }
  .file input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .about p {
    overflow-wrap: anywhere;
  }
</style>
