// Resolve stored OBS references against live state: by uuid first (survives renames), then by name.
import type { ObsInput, ObsSceneInfo, ObsSceneItem, ObsState } from './obs-types.ts';
import type { ObsRef } from './schema.ts';

export function resolveScene(obs: ObsState, ref: ObsRef): ObsSceneInfo | undefined {
  if (ref.uuid) {
    const byUuid = obs.scenes.find((s) => s.uuid === ref.uuid);
    if (byUuid) return byUuid;
  }
  return obs.scenes.find((s) => s.name === ref.name);
}

/** Scene or group name the reference points at. Groups have no uuid in our mirror. */
export function resolveSceneOrGroupName(obs: ObsState, ref: ObsRef): string | undefined {
  return resolveScene(obs, ref)?.name ?? (obs.groups.includes(ref.name) ? ref.name : undefined);
}

export function resolveInput(obs: ObsState, ref: ObsRef): ObsInput | undefined {
  if (ref.uuid) {
    for (const input of Object.values(obs.inputs)) {
      if (input.uuid === ref.uuid) return input;
    }
  }
  return obs.inputs[ref.name];
}

export function resolveSceneItem(
  obs: ObsState,
  sceneRef: ObsRef,
  sourceRef: ObsRef,
): { sceneName: string; item: ObsSceneItem } | undefined {
  const sceneName = resolveSceneOrGroupName(obs, sceneRef);
  if (!sceneName) return undefined;
  const items = obs.sceneItems[sceneName] ?? [];
  const item =
    (sourceRef.uuid ? items.find((i) => i.sourceUuid === sourceRef.uuid) : undefined) ??
    items.find((i) => i.source === sourceRef.name);
  return item ? { sceneName, item } : undefined;
}

/** A filter's owner can be an input or a scene. */
export function resolveSourceName(obs: ObsState, ref: ObsRef): string | undefined {
  return resolveInput(obs, ref)?.name ?? resolveSceneOrGroupName(obs, ref);
}
