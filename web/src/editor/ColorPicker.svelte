<script lang="ts">
  let { value = $bindable(), fallback, label }: { value?: string; fallback: string; label: string } = $props();

  const SWATCHES = ['#1c2030', '#3b4256', '#0d0f14', '#d33d3d', '#e5733a', '#c98714', '#2e9d5c', '#16968f', '#3868d6', '#7c52d8', '#c2477f', '#f2f3f7'];
</script>

<div class="colors" role="group" aria-label={label}>
  <button class="swatch auto" class:selected={!value} style:--c={fallback} title="Default" aria-label="Default color" onclick={() => (value = undefined)}>
    A
  </button>
  {#each SWATCHES as color (color)}
    <button
      class="swatch"
      class:selected={value?.toLowerCase() === color}
      style:--c={color}
      aria-label={color}
      onclick={() => (value = color)}
    ></button>
  {/each}
  <label class="swatch custom" class:selected={!!value && !SWATCHES.includes(value.toLowerCase())} title="Custom color">
    <input type="color" value={value ?? fallback} oninput={(e) => (value = e.currentTarget.value)} aria-label="Custom color" />
  </label>
</div>

<style>
  .colors {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .swatch {
    position: relative;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid rgb(255 255 255 / 0.15);
    border-radius: 9px;
    background: var(--c);
    cursor: pointer;
  }
  .swatch.selected {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .auto {
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 700;
  }
  .custom {
    overflow: hidden;
    background: conic-gradient(#e5484d, #f0a020, #30a46c, #16968f, #5b8cff, #7c52d8, #e5484d);
  }
  .custom input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
</style>
