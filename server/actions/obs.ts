// The obs.* family: needs a live OBS connection. Each action is implemented in ../obs/execute.ts.
import { OBSWebSocketError } from 'obs-websocket-js/json';
import type { ObsBridge } from '../obs/bridge.ts';
import { executeObsAction } from '../obs/execute.ts';
import { ActionError, type Executor } from './executor.ts';

export function obsExecutor(bridge: ObsBridge, screenshotDir: string): Executor<'obs'> {
  return async (action, phase) => {
    if (!bridge.connected) throw new ActionError('OBS is not connected');
    try {
      await executeObsAction(bridge.client, bridge.state, action, phase, { screenshotDir });
    } catch (err) {
      if (err instanceof OBSWebSocketError) throw new ActionError(`OBS: ${err.message || `error ${err.code}`}`);
      throw err;
    }
  };
}
