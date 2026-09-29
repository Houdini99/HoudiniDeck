<script lang="ts">
  import { onMount } from 'svelte';
  import DeckView from './deck/DeckView.svelte';
  import ButtonEditor from './editor/ButtonEditor.svelte';
  import PageManager from './editor/PageManager.svelte';
  import { setKeepAwake } from './lib/device.ts';
  import { takeKeyFromUrl } from './lib/key.ts';
  import { prefs, savePrefs } from './lib/prefs.svelte.ts';
  import IdleDim from './lib/IdleDim.svelte';
  import { store } from './lib/store.svelte.ts';
  import Toasts from './lib/Toasts.svelte';
  import UiIcon from './lib/UiIcon.svelte';
  import Pairing from './pairing/Pairing.svelte';
  import Settings from './settings/Settings.svelte';
  import UpdateDialog from './update/UpdateDialog.svelte';

  onMount(() => {
    store.start();
    // Opening a pairing link on a page that's already loaded only changes the fragment (no reload).
    const onHash = () => {
      const key = takeKeyFromUrl();
      if (key) store.pairWith(key);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      store.stop();
    };
  });

  $effect(() => savePrefs($state.snapshot(prefs)));

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo and redo deck edits in edit mode; text boxes keep their own undo.
  function onKey(e: KeyboardEvent): void {
    if (!store.editMode || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = e.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    e.preventDefault();
    void store.undo(key === 'y' || e.shiftKey);
  }
  $effect(() => setKeepAwake(prefs.keepAwake && store.conn === 'open'));

  // Leaving edit mode closes the editors.
  $effect(() => {
    if (!store.editMode) {
      store.editing = null;
      store.pagesOpen = false;
    }
  });
</script>

<svelte:window onkeydown={onKey} />

{#if store.pairing}
  <Pairing />
{:else if !store.deck || !store.obs}
  <main class="splash">
    <UiIcon name="view-grid" size={40} />
    <p>
      {#if store.updating}Updating HoudiniDeck… it’s back in a moment.{:else if store.stopped}HoudiniDeck was stopped on the PC. This page reconnects once it runs again.{:else}{store.conn === 'closed' ? 'Can’t reach the deck server. Retrying…' : 'Connecting…'}{/if}
    </p>
  </main>
{:else}
  <DeckView />
  {#if store.editing}
    {#key `${store.editing.pageId}/${store.editing.slot}`}
      <ButtonEditor />
    {/key}
  {/if}
  {#if store.pagesOpen}<PageManager />{/if}
  {#if store.settingsOpen}<Settings />{/if}
  {#if store.updateOpen}<UpdateDialog />{/if}
  {#if !store.editMode}<IdleDim />{/if}
{/if}
<Toasts />

<style>
  .splash {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    height: 100dvh;
    color: var(--muted);
  }
  .splash p {
    margin: 0;
  }
</style>
