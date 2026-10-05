// Level registry. To add a level: create its data file next to foundry.js
// and list it here. Menus, the sim, the server and the renderer all discover
// levels through this map — nothing else needs to change.
import { foundry } from './foundry.js';
import { dojo } from './dojo.js';
import { skyhaven } from './skyhaven.js';
import { feiraSuspensa } from './feiraSuspensa.js';
import { getProceduralLevel, generateProceduralLevel, newProceduralSeed } from './generator.js';

export { getProceduralLevel, generateProceduralLevel, newProceduralSeed };

const STATIC_LEVELS = {
  foundry,
  dojo,
  skyhaven,
  feira_suspensa: feiraSuspensa,
};

export const LEVELS = new Proxy(STATIC_LEVELS, {
  get(target, prop) {
    if (typeof prop === 'string') {
      if (prop === 'procedural' || prop.startsWith('procedural:')) {
        return getProceduralLevel(prop);
      }
    }
    return target[prop];
  },
  has(target, prop) {
    if (typeof prop === 'string' && (prop === 'procedural' || prop.startsWith('procedural:'))) {
      return true;
    }
    return prop in target;
  },
  ownKeys(target) {
    return [...Reflect.ownKeys(target), 'procedural'];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (prop === 'procedural') {
      return {
        configurable: true,
        enumerable: true,
        value: getProceduralLevel('procedural'),
        writable: false,
      };
    }
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
});

export const DEFAULT_LEVEL = 'foundry';
