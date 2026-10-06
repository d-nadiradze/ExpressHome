/**
 * One-off data fix for stored myhome photo URLs:
 *  - `large` renditions carry the "myhome.ge" watermark -> use `_thumb`.
 *  - static-statements.tnet.ge went dead when myhome moved its CDN -> use
 *    static-api-statements.tnet.ge (same paths).
 * Clears the myhome pre-upload cache of every touched listing so the next
 * prefill re-uploads the clean photos.
 *
 * Run:  npx tsx src/scripts/fix-watermarked-images.ts
 * Prod: docker compose exec worker node node_modules/tsx/dist/cli.mjs src/scripts/fix-watermarked-images.ts
 */
import { config } from "dotenv";
config({ path: ".env" });
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MYHOME_CDN = /^https:\/\/static(-api)?-statements\.tnet\.ge\/uploads\/(.+\/)?statements\/[^/]+\.(webp|jpe?g|png)$/i;

export function fixMyhomeImageUrl(url: string): string {
  if (!MYHOME_CDN.test(url)) return url;
  let next = url.replace("://static-statements.tnet.ge/", "://static-api-statements.tnet.ge/");
  if (!/_(thumb|blur)\.(webp|jpe?g|png)$/i.test(next)) {
    next = next.replace(/\.(webp|jpe?g|png)$/i, "_thumb.$1");
  }
  return next;
}

async function main() {
  const rows = await db.parsedListing.findMany({ select: { id: true, images: true } });
  let fixed = 0;
  for (const r of rows) {
    const images = (r.images as unknown as string[]) ?? [];
    const next = images.map(fixMyhomeImageUrl);
    if (next.every((u, i) => u === images[i])) continue;
    await db.parsedListing.update({
      where: { id: r.id },
      data: { images: next as unknown as Prisma.InputJsonValue, myhomeImageCache: Prisma.DbNull },
    });
    fixed++;
    console.log(r.id, `${images.length} photo(s) fixed`);
  }
  console.log(`checked ${rows.length}, fixed ${fixed}`);
  await db.$disconnect();
}
main();
