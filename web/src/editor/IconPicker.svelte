<script lang="ts" module>
  // Icon name lists are large (MDI has ~14k names incl. aliases); fetch each set once per session.
  const nameCache = new Map<string, Promise<string[]>>();

  function loadNames(set: string): Promise<string[]> {
    let names = nameCache.get(set);
    if (!names) {
      names = fetch(`/api/icons/${set}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j: { names: string[] }) => j.names);
      names.catch(() => nameCache.delete(set));
      nameCache.set(set, names);
    }
    return names;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type { IconSet } from '$shared/deck-utils.ts';
  import type { IconRef } from '$shared/schema.ts';
  import { prepareImage } from '../lib/device.ts';
  import Icon from '../lib/Icon.svelte';
  import { getKey } from '../lib/key.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  let { current, onpick, onclose }: { current?: IconRef; onpick: (icon: IconRef | undefined) => void; onclose: () => void } =
    $props();

  const PAGE = 120;
  const EMOJI = ['🎮', '🎙️', '🎧', '🔴', '⏺️', '🎥', '📷', '💬', '🎵', '🔇', '🔊', '⭐', '🔥', '👋', '☕', '🛑', '✅', '❌', '💤', '🍕', '🏆', '❤️', '😂', '👀'];

  type Tab = 'icons' | 'upload' | 'emoji';
  const initial = untrack(() => current); // start on the tab/set of the icon being replaced
  let tab = $state<Tab>(initial && 'upload' in initial ? 'upload' : initial && 'emoji' in initial ? 'emoji' : 'icons');
  let set = $state<IconSet>(initial && 'set' in initial ? initial.set : 'mdi');
  let query = $state('');
  let limit = $state(PAGE);
  let names = $state<string[] | null>(null);
  let loadError = $state('');
  let emoji = $state(initial && 'emoji' in initial ? initial.emoji : '');
  let uploading = $state(false);
  let uploadError = $state('');

  $effect(() => {
    const wanted = set;
    names = null;
    loadError = '';
    loadNames(wanted)
      .then((n) => {
        if (set === wanted) names = n;
      })
      .catch(() => (loadError = 'Could not load icons'));
  });

  const matches = $derived.by(() => {
    if (!names) return [];
    const q = query.trim().toLowerCase().replace(/\s+/g, '-');
    if (!q) return names;
    const starts: string[] = [];
    const contains: string[] = [];
    for (const n of names) {
      if (n.startsWith(q)) starts.push(n);
      else if (n.includes(q)) contains.push(n);
    }
    return [...starts, ...contains];
  });

  async function upload(e: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    uploading = true;
    uploadError = '';
    try {
      const form = new FormData();
      form.append('file', await prepareImage(file), file.name);
      const key = getKey();
      const res = await fetch('/api/uploads', { method: 'POST', body: form, headers: key ? { Authorization: `Bearer ${key}` } : {} });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Upload failed (HTTP ${res.status})`);
      onpick({ upload: body.file });
    } catch (err) {
      uploadError = (err as Error).message;
    } finally {
      uploading = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), onclose())} />

<div class="overlay top" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Choose an icon">
    <header>
      <h2>Icon</h2>
      <button class="icon-btn" aria-label="Close" onclick={onclose}><UiIcon name="close" /></button>
    </header>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'icons'} class:active={tab === 'icons'} onclick={() => (tab = 'icons')}>Icons</button>
      <button role="tab" aria-selected={tab === 'upload'} class:active={tab === 'upload'} onclick={() => (tab = 'upload')}>Image</button>
      <button role="tab" aria-selected={tab === 'emoji'} class:active={tab === 'emoji'} onclick={() => (tab = 'emoji')}>Emoji</button>
    </div>
    <div class="body">
      {#if tab === 'icons'}
        <div class="row search">
          <input type="search" placeholder="Search icons (e.g. mic, camera, twitch)" bind:value={query} oninput={() => (limit = PAGE)} />
          <select bind:value={set} aria-label="Icon set">
            <option value="mdi">Material</option>
            <option value="simple-icons">Brands</option>
          </select>
        </div>
        {#if loadError}
          <p class="error">{loadError}</p>
        {:else if !names}
          <p class="hint">Loading icons…</p>
        {:else if matches.length === 0}
          <p class="hint">No icons match “{query}”.</p>
        {:else}
          <div class="grid">
            {#each matches.slice(0, limit) as name (name)}
              <button
                class="choice"
                class:selected={current && 'set' in current && current.set === set && current.name === name}
                title={name}
                aria-label={name}
                onclick={() => onpick({ set, name })}
              >
                <Icon icon={{ set, name }} />
              </button>
            {/each}
          </div>
          {#if matches.length > limit}
            <button class="btn more" onclick={() => (limit += PAGE * 2)}>Show more ({matches.length - limit} left)</button>
          {/if}
        {/if}
      {:else if tab === 'upload'}
        <p class="hint">PNG, JPEG, WebP, GIF or SVG, up to 5 MB. Photos are shrunk to 512 px. The image fills the whole button.</p>
        <label class="btn primary upload" class:busy={uploading}>
          <UiIcon name="upload" size={18} />
          {uploading ? 'Uploading…' : 'Choose an image'}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onchange={upload} disabled={uploading} />
        </label>
        {#if uploadError}<p class="error">{uploadError}</p>{/if}
      {:else}
        <div class="row">
          <input type="text" maxlength="16" placeholder="Type or paste an emoji" bind:value={emoji} />
          <button class="btn primary" disabled={!emoji.trim()} onclick={() => onpick({ emoji: emoji.trim() })}>Use</button>
        </div>
        <div class="emoji-grid">
          {#each EMOJI as e (e)}
            <button class="choice emoji" onclick={() => onpick({ emoji: e })}>{e}</button>
          {/each}
        </div>
      {/if}
    </div>
    <footer>
      <button class="btn" onclick={() => onpick(undefined)}>Use the default icon</button>
    </footer>
  </div>
</div>

<style>
  .overlay.top {
    z-index: 70;
  }
  .sheet {
    max-width: 720px;
    height: min(720px, 92dvh);
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 8px 12px 0;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    padding: 8px 14px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }
  .body {
    align-content: start;
  }
  .search {
    flex-wrap: nowrap;
  }
  .search select {
    width: auto;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
    gap: 6px;
  }
  .choice {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    padding: 12px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
  }
  .choice:hover {
    border-color: var(--border);
    background: var(--surface-3);
  }
  .choice.selected {
    border-color: var(--accent);
  }
  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
    gap: 6px;
  }
  .choice.emoji {
    padding: 0;
    font-size: 26px;
  }
  .more {
    justify-self: center;
  }
  .upload {
    position: relative;
    justify-self: start;
    cursor: pointer;
  }
  .upload input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .upload.busy {
    opacity: 0.6;
  }
</style>
