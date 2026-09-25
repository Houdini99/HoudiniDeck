<script lang="ts">
  import { CATEGORIES, actionMeta, availableActionTypes, isStepType } from '$shared/actions-meta.ts';
  import { MAX_MACRO_STEPS, type ActionType, type MacroStep, type StepAction } from '$shared/schema.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';
  import ActionForm from './ActionForm.svelte';

  // A macro's steps in order: actions, each with its own form, and pauses.
  let { steps = $bindable() }: { steps: MacroStep[] } = $props();

  // No macros or toggles inside macros, no page navigation, and nothing that needs holding or dragging.
  const stepTypes = $derived(availableActionTypes(store.info?.commands ?? false, store.info?.platform).filter(isStepType));
  /** The choices by category; `current` stays listed even if this server can't run it. */
  const groupsFor = (current?: ActionType) =>
    CATEGORIES.map((category) => ({
      category,
      types: [...stepTypes, ...(current && !stepTypes.includes(current) ? [current] : [])].filter((t) => actionMeta(t).category === category),
    })).filter((g) => g.types.length > 0);

  const create = (type: string) => actionMeta(type as ActionType).create() as StepAction;

  function move(i: number, delta: number): void {
    const j = i + delta;
    [steps[i], steps[j]] = [steps[j], steps[i]];
  }
</script>

{#snippet typeOptions(current?: ActionType)}
  {#each groupsFor(current) as group (group.category)}
    <optgroup label={group.category}>
      {#each group.types as type (type)}
        <option value={type}>{actionMeta(type).label}</option>
      {/each}
    </optgroup>
  {/each}
{/snippet}

{#if steps.length}
  <ol class="steps">
    {#each steps as step, i (step)}
      <li class="step">
        <div class="head">
          <span class="num">{i + 1}</span>
          {#if 'action' in step}
            <select aria-label="Step {i + 1}" value={step.action.type} onchange={(e) => (step.action = create(e.currentTarget.value))}>
              {@render typeOptions(step.action.type)}
            </select>
          {:else}
            <label class="pause">
              Wait
              <input
                type="number"
                aria-label="Step {i + 1}: pause in milliseconds"
                min="0"
                max="60000"
                step="100"
                value={step.delayMs}
                oninput={(e) => (step.delayMs = Math.min(60000, Math.max(0, Math.round(Number(e.currentTarget.value) || 0))))}
              />
              ms
            </label>
          {/if}
          <button class="icon-btn" type="button" aria-label="Move step {i + 1} up" disabled={i === 0} onclick={() => move(i, -1)}>
            <UiIcon name="arrow-up" size={18} />
          </button>
          <button class="icon-btn" type="button" aria-label="Move step {i + 1} down" disabled={i === steps.length - 1} onclick={() => move(i, 1)}>
            <UiIcon name="arrow-down" size={18} />
          </button>
          <button class="icon-btn" type="button" aria-label="Remove step {i + 1}" onclick={() => steps.splice(i, 1)}>
            <UiIcon name="close" size={18} />
          </button>
        </div>
        {#if 'action' in step}
          <div class="form">
            <ActionForm bind:action={() => step.action, (v) => (step.action = v as StepAction)} />
          </div>
        {/if}
      </li>
    {/each}
  </ol>
{:else}
  <p class="hint">No steps yet.</p>
{/if}

{#if steps.length < MAX_MACRO_STEPS}
  <div class="add">
    <select
      aria-label="Add an action"
      value=""
      onchange={(e) => {
        steps.push({ action: create(e.currentTarget.value) });
        e.currentTarget.value = '';
      }}
    >
      <option value="" disabled>Add an action…</option>
      {@render typeOptions()}
    </select>
    <button class="btn" type="button" onclick={() => steps.push({ delayMs: 500 })}><UiIcon name="timer-sand" size={18} /> Add a pause</button>
  </div>
{/if}

<style>
  .steps {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    display: grid;
    gap: 10px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .head .icon-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .head select,
  .pause {
    flex: 1;
    min-width: 0;
  }
  .num {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    margin-right: 4px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 700;
  }
  .pause {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
  }
  .pause input {
    width: 7.5em;
  }
  .form {
    display: grid;
    gap: 12px;
    padding: 0 4px 4px 34px;
  }
  .add {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
</style>
