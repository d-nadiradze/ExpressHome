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
  postUrl: string | null;
  sourceUrl: string;
  createdAt: string;
}

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  POSTED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
};

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
      if (!res.ok) { toast.error("Failed to delete"); return; }
      setListings((prev) => prev.filter((l) => l.id !== id));
      toast.success("Listing deleted");
    } catch {
      toast.error("Something went wrong");
    }
  }

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h2 className="font-semibold text-gray-900">Recent Listings</h2>
      </div>

      {listings.length === 0 ? (
        <div className="px-6 py-12 text-center text-gray-400">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p>
            No listings yet.{" "}
            <Link href="/dashboard/parse" className="text-blue-600 underline">
              Parse your first one!
            </Link>
          </p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {listings.map((listing) => {
            const thumbs = listing.images as string[] | null;
            const thumb = thumbs?.[0];

            return (
              <Link
                key={listing.id}
                href={`/dashboard/listing/${listing.id}`}
                className="px-6 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors block"
              >
                <div className="w-16 h-12 rounded-lg overflow-hidden bg-gray-100 shrink-0">
                  {thumb ? (
                    <img src={thumb} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-300">
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">
                    {listing.title || "Untitled listing"}
                  </p>
                  <p className="text-sm text-gray-500 truncate">
                    {listing.price && `${listing.price} ${listing.currency}`}
                    {listing.address && ` · ${listing.address}`}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {new Date(listing.createdAt).toLocaleDateString("ka-GE", {
                      year: "numeric", month: "long", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className={`badge ${statusColors[listing.postStatus]}`}>
                    {listing.postStatus}
                  </span>
                  <button
                    onClick={(e) => handleDelete(e, listing.id)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                    title="Delete listing"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                  <svg className="w-5 h-5 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
