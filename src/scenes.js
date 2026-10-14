// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`) and the keys of the scene triggers
// the hub fires (manifest `scene_triggers`). Keys are forever once published.
//
// `appliance_command`: start, pause, resume or stop the program of an
// appliance. "Start" is for a washing machine only, needs the remote start
// toggle of the integration (off by default) and remote start armed on the
// machine: that is how an off-peak start works with Gladys — load the
// machine, choose the program, press remote start on it, and let a scheduled
// scene start it. Nothing that heats is started or resumed (src/commands.js).
// -----------------------------------------------------------------------------

import { TRIGGERS } from './hub.js';

export const SCENE_TRIGGER_KEYS = Object.values(TRIGGERS);

/** Handlers of the scene actions, by key. */
export function createSceneActions({ hub }) {
  return {
    async appliance_command(fields) {
      await hub.runCommand(fields.device, fields.command);
      return { sent: true };
    },
  };
}
