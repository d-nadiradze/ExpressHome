import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Identifier of the running Next.js build, used by the client to notice
 * that the server was redeployed underneath an open tab.
 *
 * `next build` writes `.next/BUILD_ID`; the standalone output copies it next
 * to `server.js`, which is our WORKDIR in the image. In `next dev` the file
 * does not exist, so fall back to a constant and the client never reloads.
 */
let cached: string | null = null;

export function getBuildId(): string {
  if (cached) return cached;
  try {
    cached = readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim() || "dev";
  } catch {
    cached = process.env.BUILD_ID || "dev";
  }
  return cached;
}
