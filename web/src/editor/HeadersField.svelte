<script lang="ts">
  import { untrack } from 'svelte';
  import UiIcon from '../lib/UiIcon.svelte';

  // HTTP headers as name/value rows, saved as { Name: 'value' }. Rows without a name aren't saved.
  let {
    value,
    onchange,
  }: { value: Record<string, string> | undefined; onchange: (headers: Record<string, string> | undefined) => void } = $props();

  const MAX_ROWS = 20;

  // The rows are the editing state; `value` only seeds them (this component is what changes it).
  let nextId = 0;
  let rows = $state(untrack(() => Object.entries(value ?? {}).map(([name, v]) => ({ id: nextId++, name, value: v }))));

  function commit(): void {
    const entries = rows.map((r) => [r.name.trim(), r.value.trim()] as const).filter(([name]) => name !== '');
    onchange(entries.length ? Object.fromEntries(entries) : undefined);
  }

  function remove(id: number): void {
    rows = rows.filter((r) => r.id !== id);
    commit();
  }
</script>

<div class="headers">
  {#each rows as row (row.id)}
    <div class="header-row">
      <input type="text" aria-label="Header name" placeholder="Name" autocapitalize="off" spellcheck="false" bind:value={row.name} onchange={commit} />
      <input type="text" aria-label="Header value" placeholder="Value" autocapitalize="off" spellcheck="false" bind:value={row.value} onchange={commit} />
      <button class="icon-btn" type="button" aria-label="Remove header" onclick={() => remove(row.id)}><UiIcon name="close" size={18} /></button>
    </div>
  {/each}
  {#if rows.length < MAX_ROWS}
    <button class="btn ghost add" type="button" onclick={() => rows.push({ id: nextId++, name: '', value: '' })}>
      <UiIcon name="plus" size={18} /> Add header
    </button>
  {/if}
</div>

<style>
  .headers {
    display: grid;
    gap: 8px;
  }
  .header-row {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto;
    gap: 6px;
  }
  .add {
    justify-self: start;
    padding-inline: 0.4em;
  }
</style>
