/**
 * Runs every src/**\/*.test.ts file in its own tsx process.
 *
 * The suites are plain node:assert scripts (no test framework), and several of
 * them stub globals like fetch, so they must not share a process.
 *
 * Run: npm test
 */
import { spawnSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

function findTests(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findTests(full, found);
    } else if (entry.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

const root = process.cwd();
const tests = findTests(join(root, "src")).sort();

if (tests.length === 0) {
  console.error("no test files found under src/");
  process.exit(1);
}

const failed: string[] = [];

for (const file of tests) {
  const rel = relative(root, file).replace(/\\/g, "/");
  const run = spawnSync(
    process.execPath,
    [join("node_modules", "tsx", "dist", "cli.mjs"), file],
    { stdio: "inherit", cwd: root }
  );
  if (run.status !== 0) failed.push(rel);
  console.log(`${run.status === 0 ? "PASS" : "FAIL"} ${rel}\n`);
}

console.log(`${tests.length - failed.length}/${tests.length} suites passed`);
if (failed.length > 0) {
  console.error(`failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
