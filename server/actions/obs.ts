// The obs.* family: needs a live OBS connection. Each action is implemented in ../obs/execute.ts.
import { OBSWebSocketError } from 'obs-websocket-js/json';
import type { ObsRef } from '../../shared/schema.ts';
import type { ObsBridge } from '../obs/bridge.ts';
import { executeObsAction, setTextSource } from '../obs/execute.ts';
import { ActionError, type Executor } from './executor.ts';

/** Writes into an OBS text source (for Counter and Timer buttons); throws ActionError when it can't. */
export type TextSetter = (ref: ObsRef, text: string) => Promise<void>;

function obsError(err: unknown): unknown {
  return err instanceof OBSWebSocketError ? new ActionError(`OBS: ${err.message || `error ${err.code}`}`) : err;
}

export function obsTextSetter(bridge: ObsBridge): TextSetter {
  return async (ref, text) => {
    if (!bridge.connected) throw new ActionError('OBS is not connected');
    try {
      await setTextSource(bridge.client, bridge.state, ref, text);
    } catch (err) {
      throw obsError(err);
    }
  };
}

export function obsExecutor(bridge: ObsBridge, screenshotDir: string): Executor<'obs'> {
  return async (action, phase) => {
    if (!bridge.connected) throw new ActionError('OBS is not connected');
    try {
      await executeObsAction(bridge.client, bridge.state, action, phase, { screenshotDir });
    } catch (err) {
      throw obsError(err);
    }
  };
}
