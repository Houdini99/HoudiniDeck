<script lang="ts">
  import { buttonVisual } from '$shared/feedback.ts';
  import { meterPos } from '$shared/fader.ts';
  import type { Button, Page } from '$shared/schema.ts';
  import { capturePointer } from '../lib/pointer.ts';
  import { haptic, prefs } from '../lib/prefs.svelte.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  const SEND_INTERVAL_MS = 50;
  const DRAG_THRESHOLD_PX = 6;

  let { page, button, interactive = true }: { page: Page; button: Button; interactive?: boolean } = $props();

  const visual = $derived(buttonVisual(button, store.visualCtx));
  const fader = $derived(visual.fader);
  /** Position under the finger while dragging, so the fill follows instantly. */
  let dragPos = $state<number | null>(null);
  const pos = $derived(dragPos ?? fader?.pos ?? 0);
  const level = $derived(fader?.input ? meterPos(store.meters[fader.input] ?? 0) : 0);
  const showLabel = $derived(prefs.showLabels && !button.hideLabel);

  $effect(() => {
    const input = fader?.input;
    if (input && interactive) return store.subscribeMeter(input);
  });

  let el: HTMLElement;
  let startY = 0;
  let startPos = 0;
  let dragging = false;
  let active = false;
  let lastSent = 0;
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  function send(value: number, force = false): void {
    const now = performance.now();
    clearTimeout(sendTimer);
    if (force || now - lastSent >= SEND_INTERVAL_MS) {
      lastSent = now;
      store.fader(page.id, button.id, value);
    } else {
      sendTimer = setTimeout(() => send(value, true), SEND_INTERVAL_MS - (now - lastSent));
    }
  }

  function onDown(e: PointerEvent): void {
    if (!fader || (e.pointerType === 'mouse' && e.button !== 0)) return;
    capturePointer(el, e);
    active = true;
    dragging = false;
    startY = e.clientY;
    startPos = pos;
    clearTimeout(releaseTimer);
  }

  function onMove(e: PointerEvent): void {
    if (!active) return;
    const dy = startY - e.clientY;
    if (!dragging && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    if (!dragging) haptic(6);
    dragging = true;
    // Relative drag: a full-height swipe moves the fader from bottom to top.
    const next = Math.min(1, Math.max(0, startPos + dy / (el.clientHeight * 0.9)));
    dragPos = next;
    send(next);
  }

  function onKey(e: KeyboardEvent): void {
    if (!fader) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(1, Math.max(0, pos + (e.key === 'ArrowUp' ? 0.05 : -0.05)));
      dragPos = next;
      send(next, true);
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => (dragPos = null), 700);
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'm') {
      e.preventDefault();
      store.press(page.id, button.id, 'tap');
    }
  }

  function onUp(): void {
    if (!active) return;
    active = false;
    if (dragging) {
      if (dragPos !== null) send(dragPos, true);
      // Keep showing the dragged value until the new volume is reported back.
      releaseTimer = setTimeout(() => (dragPos = null), 700);
    } else {
      haptic();
      store.press(page.id, button.id, 'tap'); // tap toggles mute
    }
  }
</script>

<div
  bind:this={el}
  class="fader"
  class:muted={fader?.muted}
  class:missing={visual.missing}
  class:dim={visual.offline}
  class:live={interactive}
  style:--pos={pos}
  style:--level={level}
  role="slider"
  aria-disabled={!interactive}
  aria-label={visual.label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(pos * 100)}
  tabindex={interactive ? 0 : -1}
  onpointerdown={interactive ? onDown : undefined}
  onpointermove={interactive ? onMove : undefined}
  onpointerup={interactive ? onUp : undefined}
  onpointercancel={interactive ? onUp : undefined}
  onkeydown={interactive ? onKey : undefined}
  oncontextmenu={(e) => e.preventDefault()}
>
  <div class="fill"></div>
  {#if fader?.input}<div class="meter"><div class="meter-level"></div></div>{/if}
  <div class="content">
    <UiIcon name={fader?.mic ? (fader.muted ? 'microphone-off' : 'microphone') : fader?.muted ? 'volume-off' : 'volume-high'} size={22} />
    <span class="db">{fader?.muted ? 'Muted' : fader?.text}</span>
    {#if showLabel}<span class="name">{visual.label}</span>{/if}
  </div>
</div>

<style>
  .fader {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 16%;
    background: #1c2030;
    color: #eef1f8;
    container-type: size;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.07),
      0 2px 8px rgb(0 0 0 / 0.35);
  }
  .live {
    cursor: ns-resize;
  }
  .fill {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: calc(var(--pos) * 100%);
    background: linear-gradient(to top, #3868d6, #5b8cff);
    transition: height 0.06s linear;
  }
  .muted .fill {
    background: linear-gradient(to top, #5a2a2c, #7a3336);
  }
  .meter {
    position: absolute;
    top: 8%;
    right: 7%;
    bottom: 8%;
    width: max(4px, 5cqi);
    overflow: hidden;
    border-radius: 99px;
    background: rgb(0 0 0 / 0.35);
  }
  .meter-level {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: calc(var(--level) * 100%);
    background: linear-gradient(to top, #30a46c 0%, #30a46c 70%, #f0a020 85%, #e5484d 100%);
    background-size: 100% calc(100% / max(var(--level), 0.01));
    background-position: bottom;
  }
  .content {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2cqi;
    height: 100%;
    padding: 6cqi 14cqi 6cqi 8cqi;
    text-align: center;
    pointer-events: none;
  }
  .db {
    font-size: clamp(9px, 13cqi, 20px);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .name {
    max-width: 100%;
    overflow: hidden;
    font-size: clamp(8px, 10.5cqi, 16px);
    font-weight: 600;
    opacity: 0.9;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .missing,
  .dim {
    opacity: 0.45;
  }
</style>
