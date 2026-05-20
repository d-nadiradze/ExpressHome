/** Must load before any file transformed with esbuild keepNames (e.g. page.evaluate callbacks). */
const g = globalThis as typeof globalThis & {
  __name?: (target: unknown, value?: string) => unknown;
};
if (!g.__name) g.__name = (target) => target;
