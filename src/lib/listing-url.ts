import { db } from "@/lib/db";

/** Numeric listing id from any myhome.ge URL shape (/pr/, /udzravi-qoneba/, statement, query). */
export function extractMyhomeListingIdFromUrl(url: string): string | null {
  if (!/myhome\.ge/i.test(url)) return null;

  const pr = url.match(/\/pr\/(\d+)/i);
  if (pr) return pr[1];

  const seo = url.match(/\/udzravi-qoneba\/(\d+)/i);
  if (seo) return seo[1];

  const statement = url.match(/\/statement[s]?\/(\d+)/i);
  if (statement) return statement[1];

  const queryId = url.match(/[?&](?:id|statement_id|application_id)=(\d+)/i);
  if (queryId) return queryId[1];

  return null;
}

/** Canonical listing URL for deduplication (myhome by /pr/{id}/, ss.ge by path). */
export function normalizeListingUrl(url: string): string {
  const parsed = new URL(url.trim());
  parsed.hash = "";
  parsed.search = "";

  if (parsed.hostname.includes("myhome.ge")) {
    const listingId = extractMyhomeListingIdFromUrl(parsed.href);
    if (listingId) {
      return `https://www.myhome.ge/pr/${listingId}/`;
    }
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  return `https://${host}${path}/`;
}

export async function findExistingParsedListing(userId: string, url: string) {
  const normalized = normalizeListingUrl(url);
  const listingId = extractMyhomeListingIdFromUrl(url) ?? extractMyhomeListingIdFromUrl(normalized);

  if (listingId) {
    return db.parsedListing.findFirst({
      where: {
        userId,
        OR: [
          { sourceUrl: { contains: `/pr/${listingId}/` } },
          { sourceUrl: { contains: `/udzravi-qoneba/${listingId}/` } },
        ],
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
