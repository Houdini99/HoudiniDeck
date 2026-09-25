<script lang="ts">
  import type { SettingsView } from '$shared/protocol.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  // How other programs (Streamer.bot, Home Assistant, Companion, a script) press this button over HTTP.
  let { buttonId }: { buttonId: string } = $props();

  let command = $state('');
  let error = $state('');
  let copied = $state(false);
  let box = $state<HTMLTextAreaElement>();

  /** The pairing link holds the deck's address and its access key (#k=…). */
  async function load(): Promise<void> {
    if (command) return;
    try {
      const view = await store.request<SettingsView>({ t: 'settings', action: 'get' });
      const url = new URL(view.pairing.url);
      const key = new URLSearchParams(url.hash.slice(1)).get('k') ?? '<access key>';
      command = `curl -X POST -H "Authorization: Bearer ${key}" ${url.origin}/api/buttons/${buttonId}/press`;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // The Clipboard API needs https or localhost; fall back to selecting the text.
      box?.select();
      document.execCommand('copy');
    }
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<details ontoggle={(e) => e.currentTarget.open && load()}>
  <summary>Press it from other apps</summary>
  <div class="group">
    <p class="hint">
      Streamer.bot, Home Assistant, Bitfocus Companion or a script can press this button with an HTTP POST, like this. Add
      <code>?which=longPress</code> for its long press. The command contains the access key, so keep it private.
    </p>
    {#if error}
      <p class="error">{error}</p>
    {:else if command}
      <textarea bind:this={box} readonly rows="3" onfocus={(e) => e.currentTarget.select()}>{command}</textarea>
      <div><button class="btn" type="button" onclick={copy}><UiIcon name="content-copy" size={18} />{copied ? 'Copied' : 'Copy'}</button></div>
    {:else}
      <p class="hint">Loading…</p>
    {/if}
  </div>
</details>

<style>
  .group {
    display: grid;
    gap: 10px;
  }
  textarea {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.8em;
    resize: none;
    word-break: break-all;
  }
  code {
    font-size: 0.95em;
  }
</style>
