import { CtfMode } from './ctf.js';
import { DeathMatchMode } from './deathmatch.js';
import { FfaMode } from './ffa.js';
import { SandboxDuel, SandboxDoll } from './sandbox.js';

export const MODES = {
  ctf: CtfMode,
  deathmatch: DeathMatchMode,
  ffa: FfaMode,
  'sandbox-duel': SandboxDuel,
  'sandbox-doll': SandboxDoll,
};
export const DEFAULT_MODE = 'ctf';
