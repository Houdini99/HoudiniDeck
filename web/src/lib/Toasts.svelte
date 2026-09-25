<script lang="ts">
  import { store } from './store.svelte.ts';
</script>

<div class="toasts" aria-live="polite">
  {#each store.toasts as toast (toast.id)}
    <button class="toast {toast.level}" onclick={() => store.dismiss(toast.id)}>{toast.text}</button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    bottom: max(16px, env(safe-area-inset-bottom));
    left: 50%;
    z-index: 100;
    display: grid;
    gap: 8px;
    width: min(460px, calc(100% - 24px));
    transform: translateX(-50%);
    pointer-events: none;
  }
  .toast {
    padding: 11px 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-3);
    color: var(--text);
    text-align: left;
    white-space: pre-wrap;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
    animation: slide-in 0.18s ease-out;
  }
  .toast.error {
    border-color: #6b2a2d;
    background: #3a1d1f;
    color: #ffc9ca;
  }
  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
