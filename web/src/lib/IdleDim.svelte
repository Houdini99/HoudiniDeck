<script lang="ts">
  import { formatTimeOfDay } from '$shared/format.ts';
  import { prefs } from './prefs.svelte.ts';
  import { store } from './store.svelte.ts';

  // A screen saver for tablets that stay on: after some idle minutes the deck goes dark (with a faint
  // clock). The tap that wakes it doesn't press the button underneath.
  let dimmed = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function restart(): void {
    clearTimeout(timer);
    if (prefs.dimAfterMin > 0) timer = setTimeout(() => (dimmed = true), prefs.dimAfterMin * 60_000);
  }

  $effect(() => {
    void prefs.dimAfterMin;
    dimmed = false;
    restart();
    return () => clearTimeout(timer);
  });

  function wake(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
    dimmed = false;
    restart();
  }
</script>

<svelte:window onpointerdown={restart} onkeydown={restart} />

{#if dimmed}
  <div class="dim" role="button" tabindex="-1" aria-label="Wake the deck" onpointerdown={wake} onkeydown={wake}>
    <span class="clock">{formatTimeOfDay(new Date(store.now))}</span>
    <span class="hint">Tap to wake</span>
  </div>
{/if}

<style>
  .dim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 8px;
    background: rgb(0 0 0 / 0.93);
    color: rgb(255 255 255 / 0.28);
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .clock {
    font-size: clamp(40px, 14vmin, 140px);
    font-weight: 200;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    font-size: 0.9rem;
  }
</style>
