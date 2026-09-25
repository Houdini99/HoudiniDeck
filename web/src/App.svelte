<script lang="ts">
  import { onMount } from 'svelte';
  import DeckView from './deck/DeckView.svelte';
  import ButtonEditor from './editor/ButtonEditor.svelte';
  import PageManager from './editor/PageManager.svelte';
  import { setKeepAwake } from './lib/device.ts';
  import { takeKeyFromUrl } from './lib/key.ts';
  import { prefs, savePrefs } from './lib/prefs.svelte.ts';
  import { store } from './lib/store.svelte.ts';
  import Toasts from './lib/Toasts.svelte';
  import UiIcon from './lib/UiIcon.svelte';
  import Pairing from './pairing/Pairing.svelte';
  import Settings from './settings/Settings.svelte';

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
  $effect(() => setKeepAwake(prefs.keepAwake && store.conn === 'open'));

  // Leaving edit mode closes the editors.
  $effect(() => {
    if (!store.editMode) {
      store.editing = null;
      store.pagesOpen = false;
    }
  });
</script>

{#if store.pairing}
  <Pairing />
{:else if !store.deck || !store.obs}
  <main class="splash">
    <UiIcon name="view-grid" size={40} />
    <p>{store.conn === 'closed' ? 'Can’t reach the deck server. Retrying…' : 'Connecting…'}</p>
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
