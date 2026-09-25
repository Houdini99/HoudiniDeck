// State from outside OBS (see shared/ext-types.ts). Watchers change `state` and call changed();
// the hub batches the broadcasts to the browsers.
import { EventEmitter } from 'node:events';
import { emptyExtState, type ExtState } from '../shared/ext-types.ts';

export class ExtStore extends EventEmitter<{ change: [] }> {
  readonly state: ExtState = emptyExtState();

  changed(): void {
    this.emit('change');
  }
}
