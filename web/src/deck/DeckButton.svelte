<script lang="ts">
  import { actionBehavior } from '$shared/actions-meta.ts';
  import { buttonVisual } from '$shared/feedback.ts';
  import type { Button, Page } from '$shared/schema.ts';
  import { capturePointer } from '../lib/pointer.ts';
  import { haptic, prefs } from '../lib/prefs.svelte.ts';
  import { store } from '../lib/store.svelte.ts';
  import ButtonFace from './ButtonFace.svelte';

  const LONG_PRESS_MS = 450;
  const CONFIRM_MS = 2500;

  let { page, button, interactive = true }: { page: Page; button: Button; interactive?: boolean } = $props();

  const behavior = $derived(button.tap ? actionBehavior(button.tap) : 'press');
  const visual = $derived(buttonVisual(button, { obs: store.obs!, deck: store.deck!, now: store.now }));
  const showLabel = $derived(prefs.showLabels && !button.hideLabel);

  let pressed = $state(false);
  let armed = $state(false);
  let flash = $state(false);
  let longTimer: ReturnType<typeof setTimeout> | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let longFired = false;

  // Flash red briefly when the server reports that this button's action failed.
  $effect(() => {
    if (!store.flashes[button.id]) return;
    flash = true;
    const timer = setTimeout(() => (flash = false), 700);
    return () => clearTimeout(timer);
  });

  function fire(which: 'tap' | 'longPress'): void {
    const action = which === 'tap' ? button.tap : button.longPress;
    if (!action) return;
    if (action.type === 'deck.page') store.goTo(action.pageId);
    else if (action.type === 'deck.back') store.back();
    else store.press(page.id, button.id, which);
  }

  // Tap fires on press (like hardware). Confirm-buttons need a second tap within CONFIRM_MS.
  function activate(which: 'tap' | 'longPress'): void {
    if (which === 'tap' && button.confirm) {
      if (!armed) {
        armed = true;
        clearTimeout(armTimer);
        armTimer = setTimeout(() => (armed = false), CONFIRM_MS);
        return;
      }
      armed = false;
      clearTimeout(armTimer);
    }
    fire(which);
  }

  function onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    capturePointer(e.currentTarget as HTMLElement, e);
    pressed = true;
    haptic();
    if (behavior === 'hold') {
      store.hold(page.id, button.id, true);
    } else if (button.longPress) {
      longFired = false;
      longTimer = setTimeout(() => {
        longFired = true;
        haptic(25);
        activate('longPress');
      }, LONG_PRESS_MS);
    } else {
      activate('tap');
    }
  }

  function onUp(): void {
    if (!pressed) return;
    pressed = false;
    if (behavior === 'hold') {
      store.hold(page.id, button.id, false);
    } else if (button.longPress) {
      clearTimeout(longTimer);
      if (!longFired) activate('tap');
    }
  }

  function onCancel(): void {
    if (!pressed) return;
    pressed = false;
    clearTimeout(longTimer);
    if (behavior === 'hold') store.hold(page.id, button.id, false);
  }

  // Keyboard users: Enter/Space produce a click with detail 0 (pointer clicks are handled above).
  function onClick(e: MouseEvent): void {
    if (e.detail === 0) activate('tap');
  }
</script>

{#if interactive}
  <button
    class="deck-button"
    class:pressed
    class:armed
    class:flash
    aria-label={visual.label || 'Button'}
    aria-pressed={visual.active}
    onpointerdown={onDown}
    onpointerup={onUp}
    onpointercancel={onCancel}
    onlostpointercapture={onCancel}
    onclick={onClick}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <ButtonFace {visual} {showLabel} />
    {#if armed}<span class="confirm">Tap again</span>{/if}
  </button>
{:else}
  <div class="deck-button static"><ButtonFace {visual} {showLabel} /></div>
{/if}

<style>
  .deck-button {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: none;
    border-radius: 16%;
    background: none;
    color: inherit;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    transition: transform 0.08s;
  }
  .static {
    cursor: grab;
  }
  .pressed {
    transform: scale(0.94);
  }
  .flash::after,
  .armed::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
  }
  .flash::after {
    animation: flash 0.7s ease-out;
  }
  .armed::after {
    box-shadow: inset 0 0 0 3px #fff;
    animation: armed 0.6s ease-in-out infinite alternate;
  }
  .confirm {
    position: absolute;
    right: 6%;
    bottom: 6%;
    left: 6%;
    padding: 2px 0;
    border-radius: 6px;
    background: #fff;
    color: #111;
    font-size: clamp(9px, 1.6vmin, 13px);
    font-weight: 700;
    pointer-events: none;
  }
  @keyframes flash {
    from {
      background: rgb(229 72 77 / 0.75);
    }
    to {
      background: transparent;
    }
  }
  @keyframes armed {
    to {
      box-shadow: inset 0 0 0 3px rgb(255 255 255 / 0.3);
    }
  }
</style>
