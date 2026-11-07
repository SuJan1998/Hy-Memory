/**
 * `node companion.cjs` — the executable half.
 *
 * Kept separate from `companion.ts` so the logic stays importable: an entry
 * point that runs on import cannot be tested, and tsup emits CommonJS where
 * neither `import.meta.url` nor a reliable `require.main` check is available
 * from the ESM source.
 */

import { main } from "./companion.js";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });