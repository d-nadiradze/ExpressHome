import { db } from "@/lib/db";

/** Canonical listing URL for deduplication (myhome by /pr/{id}/, ss.ge by path). */
export function normalizeListingUrl(url: string): string {
  const parsed = new URL(url.trim());
  parsed.hash = "";
  parsed.search = "";

  const myhomeMatch = parsed.pathname.match(/\/pr\/(\d+)/i);
  if (parsed.hostname.includes("myhome.ge") && myhomeMatch) {
    return `https://www.myhome.ge/pr/${myhomeMatch[1]}/`;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${path}/`;
}

export async function findExistingParsedListing(userId: string, url: string) {
  const normalized = normalizeListingUrl(url);
  const myhomeMatch = normalized.match(/\/pr\/(\d+)\//);

  if (myhomeMatch) {
    const listingId = myhomeMatch[1];
    return db.parsedListing.findFirst({
      where: {
        userId,
        sourceUrl: { contains: `/pr/${listingId}/` },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  const exact = await db.parsedListing.findFirst({
    where: { userId, sourceUrl: normalized },
    orderBy: { updatedAt: "desc" },
  });
  if (exact) return exact;

  const pathPrefix = normalized.replace(/\/$/, "");
  return db.parsedListing.findFirst({
    where: {
      userId,
      OR: [
        { sourceUrl: normalized },
        { sourceUrl: { startsWith: pathPrefix } },
        { sourceUrl: { startsWith: `${pathPrefix}/` } },
      ],
    },
    orderBy: { updatedAt: "desc" },
  });
}
