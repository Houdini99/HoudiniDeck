<script lang="ts">
  import type { ButtonVisual } from '$shared/feedback.ts';
  import Icon from '../lib/Icon.svelte';
  import UiIcon from '../lib/UiIcon.svelte';

  let { visual, showLabel = true }: { visual: ButtonVisual; showLabel?: boolean } = $props();

  // Cover art fills the button; if it can't be loaded, the icon shows instead.
  let failedImage = $state('');
  const image = $derived(visual.image && visual.image !== failedImage ? visual.image : undefined);
  const bleed = $derived(!!image || (!!visual.icon && 'upload' in visual.icon));
  const labelShown = $derived(showLabel && !!visual.label);
</script>

<div
  class="face"
  class:program={visual.ring === 'program'}
  class:preview={visual.ring === 'preview'}
  class:busy={visual.busy}
  class:alert={visual.alert}
  class:dim={visual.offline || visual.disabled}
  class:bleed
  class:has-badge={!!visual.badge}
  style:--bg={visual.bg}
  style:--fg={visual.fg}
>
  <!-- Sizes below use cqi, which resolve against .face (a size container) only inside it. -->
  <div class="inner {visual.labelPos ?? 'bottom'}">
    {#if visual.gauge}
      <div class="gauge" class:with-label={labelShown} style:--chars={Math.max(4, visual.gauge.text.length)}>
        <span class="gauge-value">{visual.gauge.text}</span>
        {#if visual.gauge.detail}<span class="gauge-detail">{visual.gauge.detail}</span>{/if}
        {#if visual.gauge.level !== undefined}
          <span class="gauge-track"><span class="gauge-fill {visual.gauge.tone ?? ''}" style:--level={visual.gauge.level}></span></span>
        {/if}
      </div>
    {:else if image}
      <div class="icon-wrap">
        <img class="art" src={image} alt="" draggable="false" onerror={() => (failedImage = image)} />
      </div>
    {:else if visual.icon}
      <div class="icon-wrap" class:with-label={labelShown && visual.labelPos !== 'middle'} class:under-label={labelShown && visual.labelPos === 'middle' && !bleed}>
        <Icon icon={visual.icon} cover={bleed} />
      </div>
    {/if}
    {#if labelShown}
      <div class="label {visual.labelSize ?? ''}">{visual.label}</div>
    {/if}
  </div>
  {#if visual.badge}
    <div class="badge {visual.tone ?? ''}">{visual.badge}</div>
  {/if}
  {#if visual.missing}
    <div class="corner warn" title="Not found in OBS"><UiIcon name="alert" size={14} /></div>
  {:else if visual.offline}
    <div class="corner" title="OBS is not connected"><UiIcon name="lan-disconnect" size={14} /></div>
  {/if}
</div>

<style>
  .face {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 16%;
    background: var(--bg);
    color: var(--fg);
    container-type: size;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.07),
      0 2px 8px rgb(0 0 0 / 0.35);
    transition:
      background-color 0.15s,
      box-shadow 0.15s,
      opacity 0.15s;
  }
  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3cqi;
    width: 100%;
    height: 100%;
    padding: 8cqi;
  }
  .icon-wrap {
    --icon-size: 56cqi;
    width: var(--icon-size);
    height: var(--icon-size);
    flex: none;
  }
  .icon-wrap.with-label {
    --icon-size: 42cqi;
  }
  .has-badge .icon-wrap {
    --icon-size: 34cqi;
    margin-top: 10cqi;
  }
  .label {
    display: -webkit-box;
    max-width: 100%;
    overflow: hidden;
    font-size: clamp(9px, 12.5cqi, 22px);
    font-weight: 600;
    line-height: 1.12;
    text-align: center;
    overflow-wrap: anywhere;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .label.small {
    font-size: clamp(8px, 10cqi, 18px);
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
  .label.large {
    font-size: clamp(11px, 17cqi, 30px);
  }
  /* Label on top: above the icon (or at the top edge of a picture). */
  .inner.top {
    flex-direction: column-reverse;
  }
  /* Label in the middle: over the icon, which keeps its full size but steps back. */
  .icon-wrap.under-label {
    opacity: 0.35;
  }
  .inner.middle .label {
    position: absolute;
    top: 50%;
    right: 6cqi;
    left: 6cqi;
    max-width: none;
    text-shadow:
      0 1px 3px rgb(0 0 0 / 0.9),
      0 0 10px rgb(0 0 0 / 0.6);
    transform: translateY(-50%);
  }
  .bleed .icon-wrap {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
  }
  .gauge {
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  /* Longer readings (a clock with seconds, a big count) get smaller so they fit. */
  .gauge-value {
    font-size: clamp(12px, min(30cqi, calc(150cqi / var(--chars))), 56px);
    font-weight: 700;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .gauge.with-label .gauge-value {
    font-size: clamp(11px, min(25cqi, calc(140cqi / var(--chars))), 48px);
  }
  .gauge-detail {
    margin-top: 3cqi;
    font-size: clamp(8px, 10cqi, 15px);
    font-weight: 600;
    opacity: 0.75;
  }
  .gauge-track {
    display: block;
    width: 62cqi;
    height: max(3px, 4cqi);
    margin-top: 5cqi;
    overflow: hidden;
    border-radius: 99px;
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
  .gauge-fill {
    display: block;
    width: calc(var(--level) * 100%);
    height: 100%;
    border-radius: inherit;
    background: #5b8cff;
    transition: width 0.4s ease-out;
  }
  .gauge-fill.warm {
    background: #f0a020;
  }
  .gauge-fill.hot {
    background: #e5484d;
  }
  .art {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
    -webkit-user-drag: none;
  }
  .bleed .label {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    max-width: none;
    padding: 16cqi 6cqi 7cqi;
    background: linear-gradient(transparent, rgb(0 0 0 / 0.78));
    color: #fff;
  }
  .bleed .inner.top .label {
    top: 0;
    bottom: auto;
    padding: 7cqi 6cqi 16cqi;
    background: linear-gradient(rgb(0 0 0 / 0.78), transparent);
  }
  .bleed .inner.middle .label {
    top: 50%;
    right: 0;
    bottom: auto;
    left: 0;
    padding: 4cqi 6cqi;
    background: rgb(0 0 0 / 0.55);
  }
  /* The ring is drawn by a pseudo-element so its cqi width is relative to this button. */
  .program::after,
  .preview::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
  }
  .program::after {
    box-shadow: inset 0 0 0 max(3px, 4.5cqi) #e5484d;
  }
  .program {
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.07),
      0 0 18px rgb(229 72 77 / 0.4);
  }
  .preview::after {
    box-shadow: inset 0 0 0 max(3px, 4.5cqi) #30a46c;
  }
  .busy {
    animation: pulse 1s ease-in-out infinite;
  }
  /* A countdown that ran out: a red ring, and the button flashes until someone taps it. */
  .alert {
    animation: alert 0.8s ease-in-out infinite alternate;
  }
  .alert::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 max(3px, 4.5cqi) #e5484d;
    pointer-events: none;
  }
  @keyframes alert {
    to {
      background: color-mix(in srgb, var(--bg) 45%, #e5484d);
    }
  }
  .dim {
    opacity: 0.42;
  }
  .badge {
    position: absolute;
    top: 6cqi;
    left: 50%;
    padding: 0.1em 0.55em;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.45);
    color: #fff;
    font-size: clamp(8px, 10cqi, 14px);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
    white-space: nowrap;
    transform: translateX(-50%);
  }
  .badge.live,
  .badge.rec {
    background: #fff;
    color: #c92a2f;
  }
  .badge.paused {
    background: #f0a020;
    color: #1f1500;
  }
  .corner {
    position: absolute;
    top: 6cqi;
    right: 6cqi;
    display: grid;
    place-items: center;
    width: max(16px, 14cqi);
    height: max(16px, 14cqi);
    border-radius: 50%;
    background: rgb(0 0 0 / 0.5);
  }
  .corner.warn {
    color: #ffb020;
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
</style>
