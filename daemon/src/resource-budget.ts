export type ResourceBudget = {
  tryAcquire(bytes: number): (() => void) | null;
  snapshot(): { usedBytes: number; maxBytes: number };
};

/** Reserves worst-case request memory before any body bytes are read. */
export const createResourceBudget = (maxBytes: number): ResourceBudget => {
  let usedBytes = 0;
  return {
    tryAcquire: (bytes) => {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - usedBytes) return null;
      usedBytes += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        usedBytes -= bytes;
      };
    },
    snapshot: () => ({ usedBytes, maxBytes }),
  };
};
