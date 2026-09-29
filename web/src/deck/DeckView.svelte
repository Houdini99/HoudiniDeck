<script lang="ts">
  import { prefs } from '../lib/prefs.svelte.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';
  import Grid from './Grid.svelte';
  import TopBar from './TopBar.svelte';

  let barOpen = $state(false);
  let generating = $state(false);

  const page = $derived(store.currentPage);
  const obs = $derived(store.obs!);
  const empty = $derived(!!page && Object.keys(page.buttons).length === 0);
  const showBar = $derived(!prefs.compact || barOpen || store.editMode);

  async function generate(): Promise<void> {
    generating = true;
    try {
      const result = await store.op<{ pageId: string }>({ op: 'deck.generateStarter' });
      if (result?.pageId) store.selectPage(result.pageId);
    } catch {
      // shown as a toast
    } finally {
      generating = false;
    }
  }
</script>

<div class="deck">
  {#if showBar}
    <TopBar />
  {/if}
  {#if prefs.compact && !store.editMode}
    <button class="handle" class:open={barOpen} aria-label={barOpen ? 'Hide menu' : 'Show menu'} onclick={() => (barOpen = !barOpen)}>
      <UiIcon name={barOpen ? 'chevron-up' : 'dots-horizontal'} />
      {#if store.updateNotice && !barOpen}<span class="notice" title="A new version of HoudiniDeck"></span>{/if}
    </button>
  {/if}

  {#if store.conn !== 'open'}
    <div class="banner">
      {#if store.updating}
        Updating HoudiniDeck… it’s back in a moment.
      {:else if store.stopped}
        HoudiniDeck was stopped on the PC. This page reconnects once it runs again.
      {:else}
        Reconnecting to the deck server…
      {/if}
    </div>
  {:else if obs.connection !== 'connected'}
    <button class="banner warn" onclick={() => (store.settingsOpen = true)}>
      <UiIcon name={obs.connection === 'connecting' ? 'timer-sand' : 'lan-disconnect'} size={18} />
      <span>{obs.connection === 'connecting' ? 'Connecting to OBS…' : (obs.error ?? 'OBS is not connected')}</span>
    </button>
  {/if}

  {#if page}
    <div class="stage" class:blocked={store.conn !== 'open'}>
      <Grid {page} />
      {#if empty && !store.editMode}
        <div class="empty-state">
          <h2>This page is empty</h2>
          <p>Fill it with buttons for your scenes, microphones and stream controls, or build it by hand.</p>
          <div class="row">
            <button class="btn primary" disabled={obs.connection !== 'connected' || generating} onclick={generate}>
              <UiIcon name="auto-fix" size={18} /> Generate from OBS
            </button>
            <button class="btn" onclick={() => (store.editMode = true)}><UiIcon name="pencil" size={18} /> Edit page</button>
          </div>
          {#if obs.connection !== 'connected'}
            <p class="hint">Connect to OBS first to generate buttons.</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .deck {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }
  .stage {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .blocked {
    pointer-events: none;
    opacity: 0.5;
  }
  .banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 14px;
    border: none;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.9rem;
    text-align: center;
  }
  button.banner {
    cursor: pointer;
  }
  .banner.warn {
    background: #3a1d1f;
    color: var(--danger-text);
  }
  .handle {
    position: fixed;
    top: max(6px, env(safe-area-inset-top));
    right: max(6px, env(safe-area-inset-right));
    z-index: 30;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 50%;
    background: rgb(40 46 64 / 0.7);
    color: var(--text);
    cursor: pointer;
    opacity: 0.6;
  }
  .handle.open,
  .handle:hover {
    opacity: 1;
  }
  .notice {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
  }
  .empty-state {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    justify-items: center;
    gap: 12px;
    width: min(440px, calc(100% - 32px));
    padding: 24px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface);
    text-align: center;
    transform: translate(-50%, -50%);
    box-shadow: 0 16px 50px rgb(0 0 0 / 0.5);
  }
  .empty-state p {
    margin: 0;
    color: var(--muted);
  }
  .empty-state .row {
    justify-content: center;
  }
</style>
