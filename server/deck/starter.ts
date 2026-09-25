// "Generate from OBS": a ready-to-use page with scenes, mic mutes and output controls.
import { slotKey } from '../../shared/deck-utils.ts';
import type { ObsState } from '../../shared/obs-types.ts';
import type { Button, Page } from '../../shared/schema.ts';

export function buildStarterPage(obs: ObsState, newId: () => string, name: string, id = newId()): Page {
  const cols = Math.min(8, Math.max(5, obs.scenes.length));
  const buttons: Record<string, Button> = {};
  let row = 0;

  const place = (group: Omit<Button, 'id'>[]) => {
    group.forEach((button, i) => {
      buttons[slotKey(row + Math.floor(i / cols), i % cols)] = { id: newId(), ...button };
    });
    row += Math.ceil(group.length / cols);
  };

  place(
    obs.scenes.slice(0, cols * 2).map((s) => ({
      tap: { type: 'obs.scene', scene: { name: s.name, uuid: s.uuid }, target: 'auto' },
    })),
  );
  place(
    Object.values(obs.inputs)
      .filter((i) => i.audio)
      .slice(0, cols)
      .map((i) => ({ tap: { type: 'obs.mute', input: { name: i.name, uuid: i.uuid }, mode: 'toggle' } })),
  );

  const controls: Omit<Button, 'id'>[] = [
    { tap: { type: 'obs.stream', mode: 'toggle' }, confirm: true },
    { tap: { type: 'obs.record', mode: 'toggle' } },
    { tap: { type: 'obs.studioMode', mode: 'toggle' } },
    { tap: { type: 'obs.transition' } },
  ];
  if (obs.replayBuffer.available) controls.push({ tap: { type: 'obs.replay', mode: 'save' } });
  if (obs.virtualCam.available) controls.push({ tap: { type: 'obs.virtualCam', mode: 'toggle' } });
  place(controls.slice(0, cols));

  return { id, name, rows: Math.max(3, row), cols, buttons };
}
