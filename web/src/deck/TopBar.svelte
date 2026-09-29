<script lang="ts">
  import { outputElapsed } from '$shared/feedback.ts';
  import { formatDuration } from '$shared/format.ts';
  import { canFullscreen, toggleFullscreen } from '../lib/device.ts';
  import { store } from '../lib/store.svelte.ts';
  import UiIcon from '../lib/UiIcon.svelte';

  const deck = $derived(store.deck!);
  const obs = $derived(store.obs!);
  const fullscreenOk = canFullscreen();

  const obsLabel = $derived(
    { connected: 'OBS', connecting: 'Connecting…', disconnected: 'OBS offline', 'auth-failed': 'OBS password' }[obs.connection],
  );
  const live = $derived(obs.stream.state === 'started' || obs.stream.state === 'reconnecting');
  const recording = $derived(obs.record.state === 'started');
  const dropped = $derived(obs.stats && obs.stats.outputTotal > 0 ? (obs.stats.outputSkipped / obs.stats.outputTotal) * 100 : 0);
  const update = $derived(store.info?.update);
  const updateLabel = $derived.by(() => {
    if (update?.state === 'downloading') return `Downloading ${Math.floor((update.progress ?? 0) * 100)}%`;
    if (update?.state === 'installing') return 'Installing…';
    if (update?.state === 'restarting') return 'Restarting…';
    return `Update ${update?.available?.version ?? ''}`.trim();
  });
</script>

<header class="topbar">
  <nav class="tabs" aria-label="Pages">
    {#each deck.pages as p (p.id)}
      <button
        class="tab"
        class:active={p.id === store.currentPage?.id}
        class:drop={store.dragOverPage === p.id}
        data-page-tab={p.id}
        onclick={() => store.selectPage(p.id)}
      >
        {#if p.id === deck.homePageId}<UiIcon name="home" size={15} />{/if}
        {p.name}
      </button>
    {/each}
    {#if store.editMode}
      <button class="tab manage" onclick={() => (store.pagesOpen = true)}><UiIcon name="view-grid-plus" size={16} /> Pages</button>
    {/if}
  </nav>

  <div class="status">
    {#if live}
      <span class="pill live" title="Streaming">LIVE {formatDuration(outputElapsed(obs.stream, store.now))}</span>
    {/if}
    {#if recording}
      <span class="pill rec" class:paused={obs.record.paused} title="Recording">
        {obs.record.paused ? 'PAUSED' : 'REC'}
        {formatDuration(outputElapsed(obs.record, store.now))}
      </span>
    {/if}
    {#if obs.connection === 'connected' && obs.stats}
      <span class="stats" title="OBS CPU usage, frame rate and dropped frames">
        CPU {obs.stats.cpu.toFixed(0)}% · {obs.stats.fps.toFixed(0)} fps{#if dropped >= 0.1}&nbsp;· {dropped.toFixed(1)}% dropped{/if}
      </span>
    {/if}
    {#if store.updateNotice}
      <button class="pill update" onclick={() => (store.updateOpen = true)} title="A new version of HoudiniDeck" aria-label={updateLabel}>
        <UiIcon name={store.updating ? 'progress-download' : 'arrow-up-circle'} size={16} /><span class="update-text">{updateLabel}</span>
      </button>
    {/if}
    <button class="pill obs {obs.connection}" onclick={() => (store.settingsOpen = true)} title={obs.error ?? `OBS ${obs.version?.obs ?? ''}`}>
      <span class="dot"></span>{obsLabel}
    </button>
  </div>

  <div class="actions">
    {#if store.editMode}
      <button
        class="icon-btn"
        title={store.history.undo ? `Undo ${store.history.undo} (Ctrl+Z)` : 'Nothing to undo'}
        aria-label="Undo"
        disabled={!store.history.undo}
        onclick={() => store.undo()}
      >
        <UiIcon name="undo" />
      </button>
      <button
        class="icon-btn"
        title={store.history.redo ? `Redo ${store.history.redo} (Ctrl+Shift+Z)` : 'Nothing to redo'}
        aria-label="Redo"
        disabled={!store.history.redo}
        onclick={() => store.undo(true)}
      >
        <UiIcon name="redo" />
      </button>
      <button class="btn primary" onclick={() => (store.editMode = false)}>Done</button>
    {:else}
      <button class="icon-btn" title="Edit layout" aria-label="Edit layout" onclick={() => (store.editMode = true)}>
        <UiIcon name="pencil" />
      </button>
    {/if}
    <button class="icon-btn" title="Settings" aria-label="Settings" onclick={() => (store.settingsOpen = true)}>
      <UiIcon name="cog" />
    </button>
    {#if fullscreenOk}
      <button class="icon-btn fs" title="Fullscreen" aria-label="Fullscreen" onclick={toggleFullscreen}>
        <UiIcon name="fullscreen" />
      </button>
    {/if}
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 54px;
    padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 6px max(10px, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .tabs {
    display: flex;
    flex: 1;
    gap: 4px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    touch-action: pan-x;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    min-height: 38px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    background: var(--surface-3);
    color: var(--text);
    font-weight: 600;
  }
  .tab.drop {
    border-color: var(--accent);
    color: var(--text);
  }
  .tab.manage {
    border: 1px dashed var(--border);
    color: var(--text);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 10px;
    border: none;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  button.pill {
    cursor: pointer;
  }
  .pill.live,
  .pill.rec {
    background: #d33d3d;
    color: #fff;
  }
  .pill.rec.paused {
    background: #f0a020;
    color: #1f1500;
  }
  .pill.update {
    background: var(--accent);
    color: var(--accent-text);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .obs.connected .dot {
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }
  .obs.connecting .dot {
    background: var(--warn);
  }
  .obs.disconnected .dot,
  .obs.auth-failed .dot {
    background: var(--danger);
  }
  .obs.disconnected,
  .obs.auth-failed {
    color: var(--danger-text);
  }
  .stats {
    color: var(--muted);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .actions .icon-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  @media (max-width: 900px) {
    .stats {
      display: none;
    }
  }
  @media (max-width: 560px) {
    .topbar {
      flex-wrap: wrap;
      row-gap: 4px;
    }
    .tabs {
      order: 3;
      flex-basis: 100%;
    }
    .status {
      flex: 1;
    }
    .fs {
      display: none;
    }
    .update-text {
      display: none;
    }
  }
</style>
