<script lang="ts">
  import { ACTION_TYPES, CATEGORIES, actionMeta } from '$shared/actions-meta.ts';
  import type { ActionType } from '$shared/schema.ts';
  import Icon from '../lib/Icon.svelte';
  import UiIcon from '../lib/UiIcon.svelte';

  // First step for a new button: pick what it does from a grid of cards.
  let { onpick, onfolder }: { onpick: (type: ActionType) => void; onfolder?: () => void } = $props();

  const groups = CATEGORIES.map((category) => ({
    category,
    types: ACTION_TYPES.filter((t) => actionMeta(t).category === category),
  }));

  const iconOf = (type: ActionType) => {
    const meta = actionMeta(type);
    return typeof meta.icon === 'function' ? meta.icon(meta.create()) : meta.icon;
  };
</script>

<div class="picker">
  {#each groups as group (group.category)}
    <section>
      <h3 class="section-title">{group.category}</h3>
      <div class="cards">
        {#each group.types as type (type)}
          <button class="card" title={actionMeta(type).description} onclick={() => onpick(type)}>
            <span class="icon"><Icon icon={iconOf(type)} /></span>
            <span>{actionMeta(type).label}</span>
          </button>
        {/each}
        {#if group.category === 'Navigation' && onfolder}
          <button class="card" title="Create a new page and a button that opens it" onclick={onfolder}>
            <span class="icon"><UiIcon name="folder-plus" size={26} /></span>
            <span>New Folder</span>
          </button>
        {/if}
      </div>
    </section>
  {/each}
</div>

<style>
  .picker {
    display: grid;
    gap: 18px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 8px;
  }
  .card {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 14px 8px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.85rem;
    line-height: 1.2;
    text-align: center;
    cursor: pointer;
  }
  .card:hover {
    border-color: var(--accent);
    background: var(--surface-3);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
  }
</style>
