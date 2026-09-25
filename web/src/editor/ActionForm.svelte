<script lang="ts">
  import { REF_KINDS, actionMeta, visibleFields, type FieldDef } from '$shared/actions-meta.ts';
  import { prettyHotkey } from '$shared/format.ts';
  import { resolveSceneOrGroupName, resolveSourceName } from '$shared/obs-resolve.ts';
  import { MEDIA_INPUT_KINDS } from '$shared/obs-types.ts';
  import type { KdeComponent } from '$shared/protocol.ts';
  import type { Action, MacroStep, ObsRef } from '$shared/schema.ts';
  import { store } from '../lib/store.svelte.ts';
  import HeadersField from './HeadersField.svelte';
  import KeysField from './KeysField.svelte';
  import MacroSteps from './MacroSteps.svelte';

  // Fields are generated from the action's metadata; OBS pickers read the live mirror.
  let { action = $bindable() }: { action: Action } = $props();

  interface Option {
    value: string;
    label: string;
    uuid?: string;
  }

  const meta = $derived(actionMeta(action.type));
  const fields = $derived(visibleFields(action));
  const values = $derived(action as unknown as Record<string, unknown>);
  const online = $derived(store.obs?.connection === 'connected');

  // Lists fetched once when a field needs them. A failed fetch leaves the list empty (a text box)
  // rather than retrying, which would loop while the server is unreachable.
  let hotkeys = $state<string[] | null>(null);
  $effect(() => {
    if (hotkeys !== null || !online || !meta.fields.some((f) => f.kind === 'hotkey')) return;
    hotkeys = [];
    store
      .request<{ hotkeys: string[] }>({ t: 'query', q: 'hotkeys' })
      .then((r) => (hotkeys = r.hotkeys))
      .catch(() => {});
  });

  let kde = $state<KdeComponent[] | null>(null);
  $effect(() => {
    if (kde !== null || !meta.fields.some((f) => f.kind === 'kdeComponent')) return;
    kde = [];
    store
      .request<{ components: KdeComponent[] }>({ t: 'query', q: 'kdeShortcuts' })
      .then((r) => (kde = r.components))
      .catch(() => {});
  });

  let players = $state<string[] | null>(null);
  $effect(() => {
    if (players !== null || !meta.fields.some((f) => f.kind === 'mediaPlayer')) return;
    players = [];
    store
      .request<{ players: string[] }>({ t: 'query', q: 'mediaPlayers' })
      .then((r) => (players = r.players))
      .catch(() => {});
  });

  const refOption = (name: string, uuid?: string, suffix = ''): Option => ({ value: name, label: name + suffix, uuid });

  function options(field: FieldDef): Option[] {
    if (field.options) return field.options;
    const obs = store.obs;
    const deck = store.deck;
    if (field.kind === 'page') return (deck?.pages ?? []).map((p) => ({ value: p.id, label: p.name }));
    if (field.kind === 'mediaPlayer') return (players ?? []).map((p) => ({ value: p, label: p }));
    if (field.kind === 'kdeComponent') return (kde ?? []).map((c) => ({ value: c.id, label: c.name }));
    if (field.kind === 'kdeShortcut') {
      const component = kde?.find((c) => c.id === values[field.dependsOn!]);
      return (component?.shortcuts ?? []).map((s) => ({ value: s.id, label: s.name }));
    }
    if (!obs) return [];
    const inputs = Object.values(obs.inputs);
    const scenes = obs.scenes.map((s) => refOption(s.name, s.uuid));
    switch (field.kind) {
      case 'scene':
        return scenes;
      case 'sceneOrGroup':
        return [...scenes, ...obs.groups.map((g) => refOption(g, undefined, ' (group)'))];
      case 'sceneItem': {
        const ref = values[field.dependsOn!] as ObsRef | undefined;
        const scene = ref?.name ? resolveSceneOrGroupName(obs, ref) : undefined;
        return scene ? (obs.sceneItems[scene] ?? []).map((i) => refOption(i.source, i.sourceUuid)) : [];
      }
      case 'audioInput':
        return inputs.filter((i) => i.audio).map((i) => refOption(i.name, i.uuid));
      case 'mediaInput': {
        const media = inputs.filter((i) => MEDIA_INPUT_KINDS.includes(i.kind));
        return (media.length ? media : inputs).map((i) => refOption(i.name, i.uuid));
      }
      case 'filterSource':
        return [...inputs.map((i) => refOption(i.name, i.uuid)), ...obs.scenes.map((s) => refOption(s.name, s.uuid, ' (scene)'))].filter(
          (o) => (obs.filters[o.value]?.length ?? 0) > 0,
        );
      case 'anySource':
        return [...obs.scenes.map((s) => refOption(s.name, s.uuid, ' (scene)')), ...inputs.map((i) => refOption(i.name, i.uuid))];
      case 'filter': {
        const ref = values[field.dependsOn!] as ObsRef | undefined;
        const source = ref?.name ? resolveSourceName(obs, ref) : undefined;
        return source ? (obs.filters[source] ?? []).map((f) => ({ value: f.name, label: f.name })) : [];
      }
      case 'hotkey':
        return (hotkeys ?? []).map((h) => ({ value: h, label: `${prettyHotkey(h)}  ·  ${h}` }));
      case 'collection':
        return obs.collections.list.map((n) => ({ value: n, label: n }));
      case 'profile':
        return obs.profiles.list.map((n) => ({ value: n, label: n }));
      case 'transition':
        return obs.transitions.map((n) => ({ value: n, label: n }));
      default:
        return [];
    }
  }

  function currentValue(field: FieldDef): string {
    const v = values[field.key];
    if (REF_KINDS.has(field.kind)) return (v as ObsRef | undefined)?.name ?? '';
    return v === undefined || v === null ? '' : String(v);
  }

  function setValue(field: FieldDef, raw: string, opts: Option[]): void {
    const target = action as unknown as Record<string, unknown>;
    if (REF_KINDS.has(field.kind)) {
      const uuid = opts.find((o) => o.value === raw)?.uuid;
      target[field.key] = raw ? { name: raw, ...(uuid ? { uuid } : {}) } : field.optional ? undefined : { name: '' };
    } else if (field.kind === 'number') {
      target[field.key] = raw === '' ? (field.optional ? undefined : 0) : Number(raw);
    } else {
      target[field.key] = raw === '' && field.optional ? undefined : raw;
    }
    // A KDE shortcut keeps its friendly name for the label.
    if (field.kind === 'kdeShortcut') target.title = opts.find((o) => o.value === raw)?.label;
    if (field.kind === 'kdeComponent') target.title = undefined;
    // Picking a different scene/source invalidates whatever was chosen below it.
    for (const dep of meta.fields.filter((f) => f.dependsOn === field.key)) {
      target[dep.key] = REF_KINDS.has(dep.kind) ? { name: '' } : '';
    }
  }

  function setRaw(field: FieldDef, value: unknown): void {
    (action as unknown as Record<string, unknown>)[field.key] = value;
  }

  /** A text box for a field whose choices depend on another one, while there's nothing to choose. */
  function locked(field: FieldDef, opts: Option[]): boolean {
    if (!field.dependsOn || opts.length > 0 || field.kind === 'text') return false;
    // KDE: with the list loaded, pick the app first; without it, names can be typed.
    if (field.kind === 'kdeShortcut') return !!kde?.length && !values[field.dependsOn];
    return online;
  }

  function placeholder(field: FieldDef): string {
    if (field.placeholder) return field.placeholder;
    if (field.dependsOn && !currentValue(meta.fields.find((f) => f.key === field.dependsOn)!)) return 'Choose the one above first';
    return online ? 'Nothing to choose from' : 'OBS is offline: type the name';
  }
</script>

{#snippet title(field: FieldDef)}
  <span>{field.label}{#if field.optional}{' '}<small>(optional)</small>{/if}</span>
{/snippet}

{#each fields as field (field.key)}
  {@const opts = options(field)}
  {@const value = currentValue(field)}
  {#if field.kind === 'headers'}
    <div class="field">
      {@render title(field)}
      <HeadersField value={values[field.key] as Record<string, string> | undefined} onchange={(v) => setRaw(field, v)} />
      {#if field.hint}<small class="hint">{field.hint}</small>{/if}
    </div>
  {:else if field.kind === 'macroSteps'}
    <div class="field">
      {@render title(field)}
      <MacroSteps bind:steps={() => values[field.key] as MacroStep[], (v) => setRaw(field, v)} />
    </div>
  {:else if field.kind === 'keys'}
    <div class="field">
      {@render title(field)}
      <KeysField bind:keys={() => (values[field.key] as string[] | undefined) ?? [], (v) => setRaw(field, v)} />
      {#if field.hint}<small class="hint">{field.hint}</small>{/if}
    </div>
  {:else if field.kind === 'checkbox'}
    <label class="toggle">
      <span>{field.label}{#if field.hint}<small>{field.hint}</small>{/if}</span>
      <input type="checkbox" checked={!!values[field.key]} onchange={(e) => setRaw(field, e.currentTarget.checked || undefined)} />
    </label>
  {:else}
    <label class="field">
      {@render title(field)}
      {#if field.kind === 'number'}
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          {value}
          oninput={(e) => setValue(field, e.currentTarget.value, opts)}
        />
      {:else if field.kind === 'url'}
        <input
          type="url"
          inputmode="url"
          autocapitalize="off"
          spellcheck="false"
          {value}
          placeholder={field.placeholder}
          onchange={(e) => setValue(field, e.currentTarget.value.trim(), opts)}
        />
      {:else if field.kind === 'multiline'}
        <textarea
          rows="4"
          autocapitalize="off"
          spellcheck="false"
          {value}
          placeholder={field.placeholder}
          onchange={(e) => setValue(field, e.currentTarget.value, opts)}
        ></textarea>
      {:else if field.kind === 'text' || (opts.length === 0 && field.kind !== 'select')}
        <input
          type="text"
          {value}
          placeholder={placeholder(field)}
          disabled={locked(field, opts)}
          onchange={(e) => setValue(field, e.currentTarget.value.trim(), opts)}
        />
      {:else}
        <select {value} onchange={(e) => setValue(field, e.currentTarget.value, opts)}>
          {#if field.optional}
            <option value="">{field.emptyLabel ?? '(none)'}</option>
          {:else if !value}
            <option value="" disabled>Choose…</option>
          {/if}
          {#if value && !opts.some((o) => o.value === value)}
            <option {value}>{value} ({field.kind === 'mediaPlayer' ? 'not running' : 'not found'})</option>
          {/if}
          {#each opts as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </select>
      {/if}
      {#if field.hint}<small class="hint">{field.hint}</small>{/if}
    </label>
  {/if}
{/each}

<style>
  textarea {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.9em;
    resize: vertical;
  }
</style>
