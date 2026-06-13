import type { WeightedDistribution } from "./types";

export interface SeededRandom {
  next(): number;
  integer(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T extends string | number>(distribution: WeightedDistribution<T>): T;
}

function hashSeed(seed: string): () => number {
  let hash = 1779033703 ^ seed.length;

  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

export function createSeededRandom(seed: string): SeededRandom {
  let state = hashSeed(seed)();

  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    integer(minInclusive, maxInclusive) {
      return Math.floor(next() * (maxInclusive - minInclusive + 1)) + minInclusive;
    },
    pick<T>(items: readonly T[]) {
      if (items.length === 0) {
        throw new Error("Cannot pick from an empty list.");
      }

      return items[Math.floor(next() * items.length)] as T;
    },
    weighted<T extends string | number>(distribution: WeightedDistribution<T>) {
      const totalWeight = distribution.values.reduce((sum, item) => sum + item.weight, 0);
      if (totalWeight <= 0) {
        throw new Error("Weighted distribution must have positive total weight.");
      }

      let cursor = next() * totalWeight;
      for (const item of distribution.values) {
        cursor -= item.weight;
        if (cursor <= 0) {
          return item.value;
        }
      }

      return distribution.values[distribution.values.length - 1]?.value as T;
    },
  };
}
