<script lang="ts">
  import { LIMITS, slotsOutside } from '$shared/deck-utils.ts';
  import type { Page } from '$shared/schema.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  const SIZES = [
    { label: '5 × 3 (Stream Deck)', rows: 3, cols: 5 },
    { label: '8 × 4 (Stream Deck XL)', rows: 4, cols: 8 },
    { label: '4 × 2 (Stream Deck Neo/+)', rows: 2, cols: 4 },
    { label: '3 × 2 (Stream Deck Mini)', rows: 2, cols: 3 },
    { label: '6 × 4 (tablet)', rows: 4, cols: 6 },
    { label: '3 × 5 (phone, portrait)', rows: 5, cols: 3 },
  ];
  const ROWS = Array.from({ length: LIMITS.maxRows }, (_, i) => i + 1);
  const COLS = Array.from({ length: LIMITS.maxCols }, (_, i) => i + 1);

  const deck = $derived(store.deck!);
  let newName = $state('');
  let newSize = $state(0);

  const quiet = () => {}; // store.op already showed a toast

  async function add(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const size = SIZES[newSize];
    const current = store.currentPage?.id;
    const result = await store.op<{ pageId: string }>({ op: 'page.add', name, rows: size.rows, cols: size.cols, afterPageId: current }).catch(quiet);
    if (result) {
      newName = '';
      store.selectPage(result.pageId);
    }
  }

  function rename(page: Page, value: string): void {
    const name = value.trim();
    if (name && name !== page.name) store.op({ op: 'page.update', pageId: page.id, name }).catch(quiet);
  }

  function resize(page: Page, rows: number, cols: number, select: HTMLSelectElement): void {
    const cut = slotsOutside(page, rows, cols).length;
    if (cut && !confirm(`The smaller grid removes ${cut} button${cut === 1 ? '' : 's'} that no longer fit. Continue?`)) {
      select.value = String(select.name === 'rows' ? page.rows : page.cols);
      return;
    }
    store.op({ op: 'page.update', pageId: page.id, rows, cols }).catch(quiet);
  }

  function remove(page: Page): void {
    const count = Object.keys(page.buttons).length;
    if (!confirm(`Delete the page “${page.name}”${count ? ` and its ${count} button${count === 1 ? '' : 's'}` : ''}?`)) return;
    store.op({ op: 'page.delete', pageId: page.id }).then(() => {
      if (store.currentPage?.id === page.id || store.pageId === page.id) store.selectPage(deck.homePageId);
    }, quiet);
  }

  function move(page: Page, delta: number): void {
    store.op({ op: 'page.move', pageId: page.id, toIndex: deck.pages.indexOf(page) + delta }).catch(quiet);
  }

  const close = () => (store.pagesOpen = false);
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Pages">
    <header>
      <h2>Pages</h2>
      <button class="icon-btn" aria-label="Close" onclick={close}><UiIcon name="close" /></button>
    </header>
    <div class="body">
      <ul class="pages">
        {#each deck.pages as page, i (page.id)}
          <li>
            <input
              type="text"
              class="name"
              maxlength="40"
              value={page.name}
              aria-label="Page name"
              onchange={(e) => rename(page, e.currentTarget.value)}
            />
            <div class="size">
              <select name="rows" aria-label="Rows" value={page.rows} onchange={(e) => resize(page, Number(e.currentTarget.value), page.cols, e.currentTarget)}>
                {#each ROWS as n (n)}<option value={n}>{n}</option>{/each}
              </select>
              <span>rows ×</span>
              <select name="cols" aria-label="Columns" value={page.cols} onchange={(e) => resize(page, page.rows, Number(e.currentTarget.value), e.currentTarget)}>
                {#each COLS as n (n)}<option value={n}>{n}</option>{/each}
              </select>
              <span>cols</span>
            </div>
            <div class="tools">
              <button
                class="icon-btn"
                class:home={page.id === deck.homePageId}
                title={page.id === deck.homePageId ? 'Home page' : 'Make this the home page'}
                aria-label="Home page"
                onclick={() => store.op({ op: 'deck.setHome', pageId: page.id }).catch(quiet)}
              >
                <UiIcon name={page.id === deck.homePageId ? 'home' : 'home-outline'} />
              </button>
              <button class="icon-btn" title="Move up" aria-label="Move up" disabled={i === 0} onclick={() => move(page, -1)}>
                <UiIcon name="arrow-up" />
              </button>
              <button class="icon-btn" title="Move down" aria-label="Move down" disabled={i === deck.pages.length - 1} onclick={() => move(page, 1)}>
                <UiIcon name="arrow-down" />
              </button>
              <button class="icon-btn danger" title="Delete page" aria-label="Delete page" disabled={deck.pages.length === 1} onclick={() => remove(page)}>
                <UiIcon name="delete" />
              </button>
            </div>
          </li>
        {/each}
      </ul>

      <form class="add" onsubmit={add}>
        <h3 class="section-title">Add a page</h3>
        <div class="row">
          <input type="text" maxlength="40" placeholder="Page name, e.g. Gaming" bind:value={newName} aria-label="New page name" />
          <select bind:value={newSize} aria-label="Grid size">
            {#each SIZES as size, i (size.label)}<option value={i}>{size.label}</option>{/each}
          </select>
          <button class="btn primary" type="submit" disabled={!newName.trim() || deck.pages.length >= LIMITS.maxPages}>Add page</button>
        </div>
        <p class="hint">Each device remembers which page it shows. To link pages together, add an “Open Page / Folder” button.</p>
      </form>
    </div>
  </div>
</div>

<style>
  .pages {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .name {
    flex: 1 1 160px;
    width: auto;
  }
  .size {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .size select {
    width: 62px;
  }
  .tools {
    display: flex;
    margin-left: auto;
  }
  .icon-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .home {
    color: var(--accent);
  }
  .danger {
    color: var(--danger-text);
  }
  .add {
    display: grid;
    gap: 8px;
  }
  .add input {
    flex: 1 1 180px;
    width: auto;
  }
  .add select {
    flex: 1 1 200px;
    width: auto;
  }
</style>
