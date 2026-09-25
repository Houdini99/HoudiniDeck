<script lang="ts">
  import { KEY_GROUPS, KEYS, MODIFIER_KEYS, isModifier, keyFromDom, shortcutLabel } from '$shared/keys.ts';

  // A shortcut: modifier toggles plus one key, or recorded from a physical keyboard.
  let { keys = $bindable() }: { keys: string[] } = $props();

  const TOGGLES: readonly string[] = MODIFIER_KEYS;
  const mods = $derived(TOGGLES.filter((m) => keys.includes(m)));
  const main = $derived(keys.find((k) => !TOGGLES.includes(k)) ?? '');
  const groups = KEY_GROUPS.map((group) => ({
    group,
    names: Object.keys(KEYS).filter((name) => KEYS[name].group === group && !TOGGLES.includes(name)),
  }));

  function set(nextMods: readonly string[], nextMain: string): void {
    keys = [...TOGGLES.filter((m) => nextMods.includes(m)), ...(nextMain ? [nextMain] : [])];
  }

  let recording = $state(false);
  /** Modifier pressed during recording, used if it's released without another key (e.g. just Super). */
  let lastModifier = '';

  function held(e: KeyboardEvent): string[] {
    return [e.ctrlKey && 'KEY_LEFTCTRL', e.shiftKey && 'KEY_LEFTSHIFT', e.altKey && 'KEY_LEFTALT', e.metaKey && 'KEY_LEFTMETA'].filter(
      (k): k is string => !!k,
    );
  }

  // Capture phase on window, so the editor's own Escape handling doesn't see these keys.
  function onKeydown(e: KeyboardEvent): void {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const name = keyFromDom(e.code);
    if (!name) return;
    if (isModifier(name)) {
      lastModifier = name;
      return;
    }
    keys = [...held(e).filter((m) => m !== name), name];
    recording = false;
  }

  function onKeyup(e: KeyboardEvent): void {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (lastModifier && keyFromDom(e.code) === lastModifier) {
      keys = [...held(e).filter((m) => m !== lastModifier), lastModifier];
      recording = false;
    }
  }

  function record(): void {
    lastModifier = '';
    recording = !recording;
  }
</script>

<svelte:window onkeydowncapture={onKeydown} onkeyupcapture={onKeyup} />

<div class="keys">
  <div class="mods" role="group" aria-label="Modifier keys">
    {#each TOGGLES as mod (mod)}
      <button
        type="button"
        class="mod"
        class:on={mods.includes(mod)}
        aria-pressed={mods.includes(mod)}
        onclick={() => set(mods.includes(mod) ? mods.filter((m) => m !== mod) : [...mods, mod], main)}
      >
        {KEYS[mod].label}
      </button>
    {/each}
  </div>
  <select aria-label="Key" value={main} onchange={(e) => set(mods, e.currentTarget.value)}>
    <option value="">(no other key)</option>
    {#each groups as g (g.group)}
      <optgroup label={g.group}>
        {#each g.names as name (name)}
          <option value={name}>{KEYS[name].label}</option>
        {/each}
      </optgroup>
    {/each}
  </select>
  <div class="record">
    <button type="button" class="btn" class:recording onclick={record}>
      {recording ? 'Press the keys now…' : 'Record from a keyboard'}
    </button>
    <span class="current" aria-live="polite">{keys.length ? shortcutLabel(keys) : 'No keys yet'}</span>
  </div>
</div>

<style>
  .keys {
    display: grid;
    gap: 8px;
  }
  .mods {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .mod {
    min-width: 64px;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--muted);
    font-weight: 600;
    cursor: pointer;
  }
  .mod.on {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-text);
  }
  .record {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .recording {
    border-color: var(--danger);
    color: var(--danger-text);
    animation: blink 1s ease-in-out infinite alternate;
  }
  .current {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  @keyframes blink {
    to {
      opacity: 0.6;
    }
  }
</style>
