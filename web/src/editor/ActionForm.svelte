<script lang="ts">
  import { REF_KINDS, actionMeta, type FieldDef } from '$shared/actions-meta.ts';
  import { prettyHotkey } from '$shared/format.ts';
  import { resolveSceneOrGroupName, resolveSourceName } from '$shared/obs-resolve.ts';
  import { MEDIA_INPUT_KINDS } from '$shared/obs-types.ts';
  import type { Action, ObsRef } from '$shared/schema.ts';
  import { store } from '../lib/store.svelte.ts';

  // Fields are generated from the action's metadata; OBS pickers read the live mirror.
  let { action = $bindable() }: { action: Action } = $props();

  interface Option {
    value: string;
    label: string;
    uuid?: string;
  }

  const meta = $derived(actionMeta(action.type));
  const values = $derived(action as unknown as Record<string, unknown>);
  const online = $derived(store.obs?.connection === 'connected');

  let hotkeys = $state<string[] | null>(null);
  $effect(() => {
    if (hotkeys !== null || !online || !meta.fields.some((f) => f.kind === 'hotkey')) return;
    hotkeys = [];
    store
      .request<{ hotkeys: string[] }>({ t: 'query', q: 'hotkeys' })
      .then((r) => (hotkeys = r.hotkeys))
      .catch(() => (hotkeys = null));
  });

  const refOption = (name: string, uuid?: string, suffix = ''): Option => ({ value: name, label: name + suffix, uuid });

  function options(field: FieldDef): Option[] {
    if (field.options) return field.options;
    const obs = store.obs;
    const deck = store.deck;
    if (field.kind === 'page') return (deck?.pages ?? []).map((p) => ({ value: p.id, label: p.name }));
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
    // Picking a different scene/source invalidates whatever was chosen below it.
    for (const dep of meta.fields.filter((f) => f.dependsOn === field.key)) {
      target[dep.key] = REF_KINDS.has(dep.kind) ? { name: '' } : '';
    }
  }

  function placeholder(field: FieldDef): string {
    if (field.dependsOn && !currentValue(meta.fields.find((f) => f.key === field.dependsOn)!)) return 'Choose the one above first';
    return online ? 'Nothing to choose from' : 'OBS is offline: type the name';
  }
</script>

{#each meta.fields as field (field.key)}
  {@const opts = options(field)}
  {@const value = currentValue(field)}
  <label class="field">
    <span>{field.label}{#if field.optional}<small> (optional)</small>{/if}</span>
    {#if field.kind === 'number'}
      <input
        type="number"
        min={field.min}
        max={field.max}
        step={field.step}
        {value}
        oninput={(e) => setValue(field, e.currentTarget.value, opts)}
      />
    {:else if field.kind === 'text' || (opts.length === 0 && field.kind !== 'select')}
      <input
        type="text"
        {value}
        placeholder={placeholder(field)}
        disabled={online && !!field.dependsOn && opts.length === 0 && field.kind !== 'text'}
        onchange={(e) => setValue(field, e.currentTarget.value.trim(), opts)}
      />
    {:else}
      <select {value} onchange={(e) => setValue(field, e.currentTarget.value, opts)}>
        {#if field.optional}
          <option value="">(none)</option>
        {:else if !value}
          <option value="" disabled>Choose…</option>
        {/if}
        {#if value && !opts.some((o) => o.value === value)}
          <option {value}>{value} (not found)</option>
        {/if}
        {#each opts as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
    {/if}
    {#if field.hint}<small class="hint">{field.hint}</small>{/if}
  </label>
{/each}
