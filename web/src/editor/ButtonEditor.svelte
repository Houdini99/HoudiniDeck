<script lang="ts">
  import {
    ACTION_TYPES,
    CATEGORIES,
    COLORS,
    actionActiveIcon,
    actionAutoLabel,
    actionBehavior,
    actionIcon,
    actionMeta,
    missingFields,
  } from '$shared/actions-meta.ts';
  import { buttonVisual } from '$shared/feedback.ts';
  import type { Action, ActionType, Appearance, Button, IconRef, NewButton } from '$shared/schema.ts';
  import ButtonFace from '../deck/ButtonFace.svelte';
  import Icon from '../lib/Icon.svelte';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';
  import ActionForm from './ActionForm.svelte';
  import ActionPicker from './ActionPicker.svelte';
  import ColorPicker from './ColorPicker.svelte';
  import IconPicker from './IconPicker.svelte';

  // Actions whose buttons light up (so an "active" look makes sense).
  const STATEFUL = new Set<ActionType>([
    'obs.scene',
    'obs.sceneItem',
    'obs.filter',
    'obs.mute',
    'obs.stream',
    'obs.record',
    'obs.replay',
    'obs.virtualCam',
    'obs.studioMode',
    'obs.collection',
    'obs.profile',
    'media.player',
  ]);

  // The editor is keyed on the slot it edits (see App.svelte), so this is fixed for its lifetime.
  const target = store.editing!;
  const existing = store.deck?.pages.find((p) => p.id === target.pageId)?.buttons[target.slot];

  type Draft = Omit<NewButton, 'active'> & { active: Appearance };
  let draft = $state<Draft>(existing ? { ...structuredClone(existing), active: { ...existing.active } } : { active: {} });

  let picking = $state(!existing);
  let folderMode = $state(false);
  let folderName = $state('');
  let previewActive = $state(false);
  let iconPickerFor = $state<'base' | 'active' | null>(null);
  let showLongPress = $state(!!existing?.longPress);
  let saving = $state(false);
  let error = $state('');

  const page = $derived(store.deck?.pages.find((p) => p.id === target.pageId));
  const ctx = $derived(store.visualCtx);
  const previewVisual = $derived(buttonVisual({ ...draft, id: existing?.id ?? 'preview' } as Button, ctx, { forceActive: previewActive }));
  const autoLabel = $derived(draft.tap ? actionAutoLabel(draft.tap, ctx) : '');
  const defaultIcon = $derived(draft.tap ? actionIcon(draft.tap) : undefined);
  const defaultActiveIcon = $derived(draft.tap ? (actionActiveIcon(draft.tap) ?? defaultIcon) : undefined);
  const stateful = $derived(!!draft.tap && STATEFUL.has(draft.tap.type));
  const ownsGesture = $derived(!!draft.tap && ['hold', 'fader'].includes(actionBehavior(draft.tap)));

  // Close if the page disappears underneath us (deleted on another device).
  $effect(() => {
    if (store.deck && !page) close();
  });

  function close(): void {
    store.editing = null;
  }

  function chooseType(type: ActionType): void {
    const meta = actionMeta(type);
    draft.tap = meta.create();
    if (!existing && meta.confirmByDefault) draft.confirm = true;
    previewActive = false;
    picking = false;
  }

  function changeTap(value: string): void {
    if (value) chooseType(value as ActionType);
    else draft.tap = undefined;
  }

  function changeLongPress(value: string): void {
    draft.longPress = value ? actionMeta(value as ActionType).create() : undefined;
  }

  function cleaned(): NewButton {
    const d = $state.snapshot(draft) as Draft;
    const active: Appearance = {};
    if (d.active.label?.trim()) active.label = d.active.label.trim();
    if (d.active.icon) active.icon = d.active.icon;
    if (d.active.bg) active.bg = d.active.bg;
    if (d.active.fg) active.fg = d.active.fg;
    return {
      ...d,
      label: d.label?.trim() || undefined,
      hideLabel: d.hideLabel || undefined,
      confirm: d.confirm || undefined,
      active: Object.keys(active).length ? active : undefined,
      longPress: ownsGesture ? undefined : d.longPress,
    };
  }

  function validate(action: Action | undefined, what: string): string | null {
    if (!action) return null;
    const missing = missingFields(action);
    return missing.length ? `${what}: choose ${missing.join(', ').toLowerCase()}.` : null;
  }

  async function save(): Promise<void> {
    error = validate(draft.tap, 'Tap action') ?? (ownsGesture ? null : validate(draft.longPress, 'Long press')) ?? '';
    if (error) return;
    saving = true;
    try {
      await store.op({ op: 'button.set', pageId: target.pageId, slot: target.slot, button: cleaned() });
      close();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  async function remove(): Promise<void> {
    if (!confirm('Delete this button?')) return;
    await store.op({ op: 'button.set', pageId: target.pageId, slot: target.slot, button: null }).then(close, () => {});
  }

  async function duplicate(): Promise<void> {
    await store.op({ op: 'button.duplicate', pageId: target.pageId, slot: target.slot }).then(() => {
      store.toast('Button duplicated');
      close();
    }, () => {});
  }

  async function createFolder(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const name = folderName.trim();
    if (!name) return;
    saving = true;
    try {
      await store.op({ op: 'folder.create', pageId: target.pageId, slot: target.slot, name });
      store.toast(`Folder “${name}” created. Open it to add buttons.`);
      close();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  function pickIcon(icon: IconRef | undefined): void {
    if (iconPickerFor === 'base') draft.icon = icon;
    else draft.active.icon = icon;
    iconPickerFor = null;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && !iconPickerFor && close()} />

<div class="overlay side" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="sheet side" role="dialog" aria-modal="true" aria-label={existing ? 'Edit button' : 'New button'}>
    <header>
      <h2>{folderMode ? 'New folder' : existing ? 'Edit button' : 'New button'}</h2>
      <button class="icon-btn" aria-label="Close" onclick={close}><UiIcon name="close" /></button>
    </header>

    <div class="body">
      {#if folderMode}
        <form class="folder" onsubmit={createFolder}>
          <p class="hint">A folder is a new page. This slot gets a button that opens it, and the new page gets a Back button.</p>
          <label class="field">
            <span>Folder name</span>
            <!-- svelte-ignore a11y_autofocus -->
            <input type="text" maxlength="40" bind:value={folderName} placeholder="e.g. Scenes, Audio, BRB" autofocus />
          </label>
          {#if error}<p class="error">{error}</p>{/if}
          <div class="row">
            <button class="btn" type="button" onclick={() => (folderMode = false)}>Back</button>
            <button class="btn primary" type="submit" disabled={!folderName.trim() || saving}>Create folder</button>
          </div>
        </form>
      {:else if picking}
        <p class="lead">What should this button do?</p>
        <ActionPicker onpick={chooseType} onfolder={() => (folderMode = true)} />
        <button class="btn ghost skip" onclick={() => (picking = false)}>Skip: just a label or image</button>
      {:else}
        <div class="preview-row">
          <div class="preview"><ButtonFace visual={previewVisual} showLabel={!draft.hideLabel} /></div>
          {#if stateful}
            <div class="segmented" role="group" aria-label="Preview">
              <button class:active={!previewActive} onclick={() => (previewActive = false)}>Normal</button>
              <button class:active={previewActive} onclick={() => (previewActive = true)}>Active</button>
            </div>
          {/if}
        </div>

        <section class="group">
          <h3 class="section-title">Action</h3>
          <label class="field">
            <span>When tapped</span>
            <select value={draft.tap?.type ?? ''} onchange={(e) => changeTap(e.currentTarget.value)}>
              <option value="">Nothing</option>
              {#each CATEGORIES as category (category)}
                <optgroup label={category}>
                  {#each ACTION_TYPES.filter((t) => actionMeta(t).category === category) as type (type)}
                    <option value={type}>{actionMeta(type).label}</option>
                  {/each}
                </optgroup>
              {/each}
            </select>
          </label>
          {#if draft.tap}
            <p class="hint">{actionMeta(draft.tap.type).description}</p>
            <ActionForm bind:action={() => draft.tap!, (v) => (draft.tap = v)} />
          {/if}
        </section>

        <section class="group">
          <h3 class="section-title">Appearance</h3>
          <label class="field">
            <span>Label</span>
            <input type="text" maxlength="80" bind:value={draft.label} placeholder={autoLabel || 'No label'} />
          </label>
          <label class="toggle">
            <span>Show the label</span>
            <input type="checkbox" checked={!draft.hideLabel} onchange={(e) => (draft.hideLabel = !e.currentTarget.checked)} />
          </label>
          <div class="field">
            <span>Icon</span>
            <div class="row">
              <div class="icon-preview">
                {#if draft.icon ?? defaultIcon}<Icon icon={(draft.icon ?? defaultIcon)!} />{/if}
              </div>
              <button class="btn" onclick={() => (iconPickerFor = 'base')}>Change…</button>
              {#if draft.icon}<button class="btn ghost" onclick={() => (draft.icon = undefined)}>Use default</button>{/if}
            </div>
          </div>
          <div class="field">
            <span>Background</span>
            <ColorPicker label="Background" bind:value={draft.bg} fallback={COLORS.bg} />
          </div>
          <div class="field">
            <span>Text and icon</span>
            <ColorPicker label="Text and icon color" bind:value={draft.fg} fallback={COLORS.fg} />
          </div>
        </section>

        {#if stateful}
          <details ontoggle={(e) => (previewActive = e.currentTarget.open)}>
            <summary>Look while active (live, muted, visible…)</summary>
            <div class="group">
              <label class="field">
                <span>Label while active</span>
                <input type="text" maxlength="80" bind:value={draft.active.label} placeholder="Same as normal" />
              </label>
              <div class="field">
                <span>Icon while active</span>
                <div class="row">
                  <div class="icon-preview">
                    {#if draft.active.icon ?? draft.icon ?? defaultActiveIcon}
                      <Icon icon={(draft.active.icon ?? draft.icon ?? defaultActiveIcon)!} />
                    {/if}
                  </div>
                  <button class="btn" onclick={() => (iconPickerFor = 'active')}>Change…</button>
                  {#if draft.active.icon}<button class="btn ghost" onclick={() => (draft.active.icon = undefined)}>Use default</button>{/if}
                </div>
              </div>
              <div class="field">
                <span>Background while active</span>
                <ColorPicker label="Active background" bind:value={draft.active.bg} fallback={previewVisual.bg} />
              </div>
              <div class="field">
                <span>Text and icon while active</span>
                <ColorPicker label="Active text color" bind:value={draft.active.fg} fallback={draft.fg ?? COLORS.fg} />
              </div>
            </div>
          </details>
        {/if}

        {#if ownsGesture}
          <p class="hint">This action uses press-and-hold or dragging, so it can’t have a separate long-press action.</p>
        {:else}
          <details bind:open={showLongPress}>
            <summary>Long press (optional second action)</summary>
            <div class="group">
              <label class="field">
                <span>When held for half a second</span>
                <select value={draft.longPress?.type ?? ''} onchange={(e) => changeLongPress(e.currentTarget.value)}>
                  <option value="">Nothing</option>
                  {#each CATEGORIES as category (category)}
                    <optgroup label={category}>
                      {#each ACTION_TYPES.filter((t) => actionMeta(t).category === category && t !== 'obs.volume') as type (type)}
                        <option value={type}>{actionMeta(type).label}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </select>
              </label>
              {#if draft.longPress}
                <ActionForm bind:action={() => draft.longPress!, (v) => (draft.longPress = v)} />
              {/if}
            </div>
          </details>
        {/if}

        <label class="toggle">
          <span>
            Ask for a second tap
            <small>Protects against accidental presses. On by default for Stream buttons.</small>
          </span>
          <input type="checkbox" bind:checked={draft.confirm} />
        </label>

        {#if error}<p class="error">{error}</p>{/if}
      {/if}
    </div>

    {#if !picking && !folderMode}
      <footer>
        {#if existing}
          <button class="btn danger" onclick={remove}><UiIcon name="delete" size={18} /> Delete</button>
          <button class="btn" onclick={duplicate}><UiIcon name="content-copy" size={18} /> Duplicate</button>
        {/if}
        <span class="spacer"></span>
        <button class="btn" onclick={close}>Cancel</button>
        <button class="btn primary" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </footer>
    {/if}
  </div>
</div>

{#if iconPickerFor}
  <IconPicker
    current={iconPickerFor === 'base' ? draft.icon : draft.active.icon}
    onpick={pickIcon}
    onclose={() => (iconPickerFor = null)}
  />
{/if}

<style>
  @media (min-width: 900px) {
    .overlay.side {
      align-items: stretch;
      justify-content: flex-end;
      padding: 0;
      background: rgb(0 0 0 / 0.25);
    }
    .sheet.side {
      max-width: 460px;
      height: 100%;
      max-height: none;
      border-width: 0 0 0 1px;
      border-radius: 0;
    }
  }
  .lead {
    margin: 0;
    font-weight: 600;
  }
  .skip {
    justify-self: center;
    color: var(--muted);
  }
  .preview-row {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .preview {
    width: 120px;
    height: 120px;
    flex: none;
  }
  .segmented {
    display: inline-flex;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
  }
  .segmented button {
    padding: 6px 12px;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .segmented button.active {
    background: var(--surface-3);
    color: var(--text);
  }
  .group {
    display: grid;
    gap: 14px;
  }
  .icon-preview {
    width: 40px;
    height: 40px;
    padding: 6px;
    border-radius: 10px;
    background: var(--surface-3);
    --icon-size: 28px;
  }
  .folder {
    display: grid;
    gap: 14px;
  }
</style>
