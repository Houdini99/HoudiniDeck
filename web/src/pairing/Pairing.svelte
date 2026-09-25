<script lang="ts">
  import { parseKey } from '../lib/key.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  let input = $state('');
  let invalid = $state(false);

  const message = $derived(
    {
      needed: 'This deck only accepts paired devices. Scan the QR code shown in the terminal where the server runs, or in Settings on a device that is already paired.',
      'bad-key': 'That key didn’t work. Scan the current QR code again.',
      'key-rotated': 'The access key was changed on the server. Scan the new QR code to reconnect.',
    }[store.pairing ?? 'needed'],
  );

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const key = parseKey(input);
    invalid = !key;
    if (key) store.pairWith(key);
  }
</script>

<main class="pairing">
  <div class="card">
    <div class="logo"><UiIcon name="view-grid" size={34} /></div>
    <h1>Pair this device</h1>
    <p>{message}</p>
    <form onsubmit={submit}>
      <label class="field">
        <span>Or paste the pairing link or access key</span>
        <input type="text" bind:value={input} autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="http://…/#k=…" />
      </label>
      {#if invalid}<p class="error">That doesn’t look like a pairing link or key.</p>{/if}
      <button class="btn primary" type="submit" disabled={!input.trim()}>Connect</button>
    </form>
  </div>
</main>

<style>
  .pairing {
    display: grid;
    place-items: center;
    height: 100dvh;
    padding: 20px;
    overflow: auto;
  }
  .card {
    display: grid;
    gap: 14px;
    width: min(440px, 100%);
    padding: 28px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 14px;
    background: var(--surface-3);
    color: var(--accent);
  }
  h1 {
    font-size: 1.35rem;
  }
  p {
    margin: 0;
    color: var(--muted);
  }
  form {
    display: grid;
    gap: 12px;
  }
</style>
