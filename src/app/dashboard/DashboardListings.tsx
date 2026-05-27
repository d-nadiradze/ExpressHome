"use client";

import { useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";

interface Listing {
  id: string;
  title: string | null;
  price: string | null;
  currency: string | null;
  description: string | null;
  address: string | null;
  area: string | null;
  rooms: string | null;
  floor: string | null;
  totalFloors: string | null;
  images: string[] | null;
  rawData: Record<string, string> | null;
  postStatus: string;
  ssgePostStatus: string;
  postUrl: string | null;
  sourceUrl: string;
  createdAt: string;
}

const statusBadgeClass: Record<string, string> = {
  PARSING: "badge-parsing",
  PENDING: "badge-pending",
  POSTED: "badge-posted",
  FAILED: "badge-failed",
};

function formatPrice(price: string | null, currency: string | null) {
  if (!price) return null;
  const symbol = currency === "GEL" ? "₾" : "$";
  return `${price} ${symbol}`;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("ka-GE", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function DashboardListings({ initialListings }: { initialListings: Listing[] }) {
  const [listings, setListings] = useState<Listing[]>(initialListings);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this listing? This cannot be undone.")) return;
    try {
      const res = await fetch("/api/myhome/parse", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        toast.error("Failed to delete");
        return;
      }
      setListings((prev) => prev.filter((l) => l.id !== id));
      toast.success("Listing deleted");
    } catch {
      toast.error("Something went wrong");
    }
  }

  return (
    <section aria-labelledby="listings-heading">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 id="listings-heading" className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Your listings
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {listings.length === 0
              ? "No listings yet"
              : `${listings.length} listing${listings.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 px-6 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 mb-4">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">Start with your first listing</h3>
          <p className="text-sm text-slate-500 mt-2 max-w-sm leading-relaxed">
            Paste a URL from any supported site and we&apos;ll extract photos, price, and details automatically.
          </p>
          <Link href="/dashboard/parse" className="btn-primary mt-6">
            Parse your first listing
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map((listing) => {
            const thumbs = listing.images as string[] | null;
            const thumb = thumbs?.[0];
            const priceLabel = formatPrice(listing.price, listing.currency);

            return (
              <article key={listing.id} className="listing-card group">
                <Link
                  href={`/dashboard/listing/${listing.id}`}
                  className="flex flex-col flex-1 outline-none"
                >
                  <div className="relative aspect-[16/10] overflow-hidden bg-slate-100 dark:bg-slate-800">
                    {thumb ? (
                      <img
                        src={thumb}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-300">
                        <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                    )}
                    {priceLabel && (
                      <div className="absolute bottom-3 left-3 rounded-lg bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm px-2.5 py-1 text-sm font-bold text-slate-900 dark:text-slate-50 shadow-sm tabular-nums">
                        {priceLabel}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-1 flex-col p-4">
                    <h3 className="font-semibold text-slate-900 dark:text-slate-50 line-clamp-2 leading-snug group-hover:text-slate-700 dark:group-hover:text-slate-300 transition-colors">
                      {listing.title || "Untitled listing"}
                    </h3>

                    {listing.address && (
                      <p className="text-sm text-slate-500 mt-1.5 line-clamp-1 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        </svg>
                        {listing.address}
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2 mt-3">
                      {listing.area && (
                        <span className="tag-pill tabular-nums">{listing.area} m²</span>
                      )}
                      {listing.rooms && (
                        <span className="tag-pill">{listing.rooms} rooms</span>
                      )}
                      {listing.floor && (
                        <span className="tag-pill tabular-nums">
                          Floor {listing.floor}
                          {listing.totalFloors ? `/${listing.totalFloors}` : ""}
                        </span>
                      )}
                    </div>

                    <div className="mt-auto pt-4 flex items-center justify-between gap-2 border-t border-slate-100 dark:border-slate-800">
                      <div className="flex flex-wrap gap-1.5">
                        <span className={`badge ${statusBadgeClass[listing.postStatus] || "badge-pending"}`}>
                          MH · {listing.postStatus}
                        </span>
                        <span className={`badge ${statusBadgeClass[listing.ssgePostStatus] || "badge-pending"}`}>
                          SS · {listing.ssgePostStatus}
                        </span>
                      </div>
                      <time className="text-xs text-slate-400 shrink-0" dateTime={listing.createdAt}>
                        {formatDate(listing.createdAt)}
                      </time>
                    </div>
                  </div>
                </Link>

                <button
                  onClick={(e) => handleDelete(e, listing.id)}
                  className="absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-xl bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm text-slate-500 opacity-0 shadow-sm transition-all duration-200 hover:bg-red-50 dark:hover:bg-red-950/50 hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  aria-label="Delete listing"
                  title="Delete listing"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
