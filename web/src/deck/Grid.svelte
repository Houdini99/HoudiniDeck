<script lang="ts">
  import { actionBehavior } from '$shared/actions-meta.ts';
  import { slotKey } from '$shared/deck-utils.ts';
  import { buttonVisual } from '$shared/feedback.ts';
  import type { Button, Page } from '$shared/schema.ts';
  import { capturePointer } from '../lib/pointer.ts';
  import { haptic, prefs } from '../lib/prefs.svelte.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';
  import ButtonFace from './ButtonFace.svelte';
  import DeckButton from './DeckButton.svelte';
  import VolumeTile from './VolumeTile.svelte';

  let { page }: { page: Page } = $props();

  const slots = $derived(
    Array.from({ length: page.rows * page.cols }, (_, i) => slotKey(Math.floor(i / page.cols), i % page.cols)),
  );

  interface Drag {
    slot: string;
    button: Button;
    x: number;
    y: number;
    w: number;
    h: number;
    grabX: number;
    grabY: number;
    overSlot: string | null;
  }
  let drag = $state<Drag | null>(null);

  function targetAt(x: number, y: number): { slot?: string; page?: string } {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-slot], [data-page-tab]');
    if (!el) return {};
    return el.dataset.slot ? { slot: el.dataset.slot } : { page: el.dataset.pageTab };
  }

  async function drop(d: Drag, x: number, y: number): Promise<void> {
    const target = targetAt(x, y);
    try {
      if (target.slot && target.slot !== d.slot) {
        await store.op({ op: 'button.move', from: { pageId: page.id, slot: d.slot }, to: { pageId: page.id, slot: target.slot } });
      } else if (target.page && target.page !== page.id) {
        await store.op({ op: 'button.move', from: { pageId: page.id, slot: d.slot }, to: { pageId: target.page } });
        store.toast(`Moved to “${store.deck?.pages.find((p) => p.id === target.page)?.name}”`);
      }
    } catch {
      // store.op already showed the error
    }
  }

  // Edit mode: tap a button to edit it; drag it (mouse: move 5px, touch: hold 250ms) to move it.
  function onEditPointerDown(e: PointerEvent, slot: string): void {
    const button = page.buttons[slot];
    if (!button || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = e.currentTarget as HTMLElement;
    capturePointer(el, e);
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const touch = e.pointerType !== 'mouse';
    let started = false;
    let cancelled = false;

    const begin = (x: number, y: number) => {
      started = true;
      haptic(8);
      drag = { slot, button, x, y, w: rect.width, h: rect.height, grabX: startX - rect.left, grabY: startY - rect.top, overSlot: null };
    };
    const holdTimer = touch ? setTimeout(() => !cancelled && begin(startX, startY), 250) : undefined;

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (touch && dist > 10) {
          cancelled = true;
          clearTimeout(holdTimer);
        } else if (!touch && dist > 5) {
          begin(ev.clientX, ev.clientY);
        }
      }
      if (started && drag) {
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        const t = targetAt(ev.clientX, ev.clientY);
        drag.overSlot = t.slot ?? null;
        store.dragOverPage = t.page && t.page !== page.id ? t.page : null;
      }
    };
    const finish = (ev: PointerEvent, commit: boolean) => {
      clearTimeout(holdTimer);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      if (started) {
        const d = drag;
        drag = null;
        store.dragOverPage = null;
        if (commit && d) void drop(d, ev.clientX, ev.clientY);
      } else if (commit && !cancelled) {
        store.editing = { pageId: page.id, slot };
      }
    };
    const onUp = (ev: PointerEvent) => finish(ev, true);
    const onCancel = (ev: PointerEvent) => finish(ev, false);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  }

  function onEditKey(e: KeyboardEvent, slot: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      store.editing = { pageId: page.id, slot };
    }
  }
</script>

<div class="wrap" class:compact={prefs.compact} class:editing={store.editMode}>
  <div class="grid" style:--rows={page.rows} style:--cols={page.cols}>
    {#each slots as slot (slot)}
      {@const button = page.buttons[slot]}
      {#if button && store.editMode}
        <div
          class="cell edit"
          class:over={drag?.overSlot === slot && drag.slot !== slot}
          class:lifted={drag?.slot === slot}
          data-slot={slot}
          role="button"
          tabindex="0"
          aria-label="Edit button"
          onpointerdown={(e) => onEditPointerDown(e, slot)}
          onkeydown={(e) => onEditKey(e, slot)}
        >
          {#if button.tap && actionBehavior(button.tap) === 'fader'}
            <VolumeTile {page} {button} interactive={false} />
          {:else}
            <DeckButton {page} {button} interactive={false} />
          {/if}
        </div>
      {:else if button}
        <div class="cell" data-slot={slot}>
          {#if button.tap && actionBehavior(button.tap) === 'fader'}
            <VolumeTile {page} {button} />
          {:else}
            <DeckButton {page} {button} />
          {/if}
        </div>
      {:else}
        <div class="cell" class:over={drag?.overSlot === slot} data-slot={slot}>
          {#if store.editMode}
            <button class="empty" aria-label="Add a button" onclick={() => (store.editing = { pageId: page.id, slot })}>
              <UiIcon name="plus" size={26} />
            </button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
</div>

{#if drag}
  <div
    class="ghost"
    style:left="{drag.x - drag.grabX}px"
    style:top="{drag.y - drag.grabY}px"
    style:width="{drag.w}px"
    style:height="{drag.h}px"
  >
    <ButtonFace visual={buttonVisual(drag.button, store.visualCtx)} />
  </div>
{/if}

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
    container-type: size;
  }
  .wrap.compact {
    padding: max(6px, env(safe-area-inset-top)) max(6px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom))
      max(6px, env(safe-area-inset-left));
  }
  .grid {
    --gap: clamp(6px, 1.6cqmin, 16px);
    /* Square cells, as large as fits both ways. */
    --cell: min(
      calc((100cqw - (var(--cols) - 1) * var(--gap)) / var(--cols)),
      calc((100cqh - (var(--rows) - 1) * var(--gap)) / var(--rows))
    );
    display: grid;
    grid-template-columns: repeat(var(--cols), var(--cell));
    grid-template-rows: repeat(var(--rows), var(--cell));
    gap: var(--gap);
  }
  .compact .grid {
    --gap: clamp(4px, 1cqmin, 10px);
  }
  .cell {
    position: relative;
    min-width: 0;
    min-height: 0;
    border-radius: 16%;
  }
  .cell.edit {
    cursor: grab;
    touch-action: none;
    outline: 1px dashed rgb(255 255 255 / 0.28);
    outline-offset: 3px;
  }
  .cell.over {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .cell.lifted {
    opacity: 0.25;
  }
  .empty {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border: 2px dashed var(--border);
    border-radius: 16%;
    background: rgb(255 255 255 / 0.02);
    color: var(--muted);
    cursor: pointer;
  }
  .empty:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .ghost {
    position: fixed;
    z-index: 40;
    pointer-events: none;
    transform: scale(1.06);
    filter: drop-shadow(0 12px 24px rgb(0 0 0 / 0.55));
  }
</style>
