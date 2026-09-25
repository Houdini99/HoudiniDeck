<script lang="ts">
  import { CATEGORIES, actionMeta, availableActionTypes, isStepType } from '$shared/actions-meta.ts';
  import type { ActionType, ToggleSide } from '$shared/schema.ts';
  import { store } from '../lib/store.svelte.ts';
  import ActionForm from './ActionForm.svelte';

  // One side of a toggle: any action a macro step could be, or a whole macro.
  let { action = $bindable() }: { action: ToggleSide } = $props();

  const types = $derived(
    availableActionTypes(store.info?.commands ?? false, store.info?.platform).filter((t) => t === 'macro' || isStepType(t)),
  );
  /** The choices by category; the current type stays listed even if this server can't run it. */
  const groups = $derived(
    CATEGORIES.map((category) => ({
      category,
      types: [...types, ...(types.includes(action.type) ? [] : [action.type])].filter((t) => actionMeta(t).category === category),
    })).filter((g) => g.types.length > 0),
  );
</script>

<div class="toggle-side">
  <select aria-label="Action" value={action.type} onchange={(e) => (action = actionMeta(e.currentTarget.value as ActionType).create() as ToggleSide)}>
    {#each groups as group (group.category)}
      <optgroup label={group.category}>
        {#each group.types as type (type)}
          <option value={type}>{actionMeta(type).label}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <div class="form">
    <ActionForm bind:action={() => action, (v) => (action = v as ToggleSide)} />
  </div>
</div>

<style>
  .toggle-side {
    display: grid;
    gap: 10px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .form {
    display: grid;
    gap: 12px;
    padding: 0 4px 4px;
  }
</style>
