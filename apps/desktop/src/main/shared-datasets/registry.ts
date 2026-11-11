import type {
  AnySharedDatasetDefinition,
  SharedDatasetDefinition,
  SharedDatasetRegistry,
  SharedItem,
} from './types.js';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createSharedDatasetRegistry(): SharedDatasetRegistry & {
  register<Item extends SharedItem, Extras>(
    def: SharedDatasetDefinition<Item, Extras>,
  ): () => void;
} {
  const defs = new Map<string, AnySharedDatasetDefinition>();
  return {
    register(def) {
      if (!ID.test(def.id)) throw new Error(`invalid shared dataset id: ${def.id}`);
      if (defs.has(def.id)) throw new Error(`shared dataset already registered: ${def.id}`);
      defs.set(def.id, def);
      return () => {
        if (defs.get(def.id) === def) defs.delete(def.id);
      };
    },
    get: (id) => defs.get(id),
    list: () => [...defs.values()],
  };
}

/** Process-wide registry; datasets register at startup and stay inert until enabled. */
export const sharedDatasetRegistry = createSharedDatasetRegistry();

export function registerSharedDataset<Item extends SharedItem, Extras>(
  def: SharedDatasetDefinition<Item, Extras>,
): () => void {
  return sharedDatasetRegistry.register(def);
}
