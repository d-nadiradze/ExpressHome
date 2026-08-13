"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { cn } from "@/lib/utils";
import { MARKET_PROPERTY_TYPES, type MarketPropertyType } from "@/lib/market-constants";

type MarketListing = {
  id: string;
  platform: "MYHOME" | "SSGE";
  url: string;
  propertyType: string;
  district: string | null;
  street: string | null;
  streetNumber: string | null;
  area: string | null;
  rooms: string | null;
  floor: string | null;
  price: string | null;
  currency: string | null;
  title: string | null;
  imageUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  sourcePostedAt: string | null;
  isSpecial: boolean;
};

type ListResponse = {
  listings: MarketListing[];
  total: number;
  limit: number;
  minutes: number | null;
  windowMs: number | null;
  lastPolledAt: string | null;
  lastError: string | null;
  newWindowMs?: number;
};

function formatPrice(price: string | null, currency: string | null) {
  if (!price) return null;
  const symbol = currency === "GEL" ? "₾" : "$";
  return `${price} ${symbol}`;
}

function formatWhen(dateStr: string | null) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleString("ka-GE", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCount(shown: number, total: number, limit: number) {
  if (total > limit && shown >= limit) {
    return `${shown} of ${total} listings`;
  }
  return `${total} listing${total === 1 ? "" : "s"}`;
}

function addressLine(listing: MarketListing) {
  const street = [listing.street, listing.streetNumber].filter(Boolean).join(" ");
  return [listing.district, street].filter(Boolean).join(" · ");
}

function ListingCard({ listing }: { listing: MarketListing }) {
  const router = useRouter();
  const [parsing, setParsing] = useState(false);
  const priceLabel = formatPrice(listing.price, listing.currency);

  async function handleParse() {
    setParsing(true);
    try {
      const res = await fetch("/api/myhome/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: listing.url }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to start parse");
        return;
      }
      toast.success(data.cached ? "Already parsed" : "Parse started");
      if (data.listingId) {
        router.push(`/dashboard/listing/${data.listingId}`);
      }
    } catch {
      toast.error("Failed to start parse");
    } finally {
      setParsing(false);
    }
  }

  return (
    <article className="listing-card group">
      <div className="relative aspect-[16/10] overflow-hidden bg-slate-100 dark:bg-slate-800">
        {listing.imageUrl ? (
          <img
            src={listing.imageUrl}
            alt=""
            className="h-full w-full object-cover"
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
        <span className="absolute top-3 left-3 badge bg-white/95 dark:bg-slate-900/90 text-slate-700 dark:text-slate-200">
          {listing.platform === "MYHOME" ? "myhome.ge" : "ss.ge"}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-semibold text-slate-900 dark:text-slate-50 line-clamp-2 leading-snug">
          {listing.title || "Untitled listing"}
        </h3>
        {addressLine(listing) && (
          <p className="text-sm text-slate-500 mt-1.5 line-clamp-1">{addressLine(listing)}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-3">
          {listing.area && <span className="tag-pill tabular-nums">{listing.area} m²</span>}
          {listing.rooms && <span className="tag-pill">{listing.rooms} rooms</span>}
          {listing.floor && <span className="tag-pill tabular-nums">Floor {listing.floor}</span>}
        </div>
        <p className="text-xs text-slate-400 mt-3">
          First seen {formatWhen(listing.firstSeenAt)}
        </p>
        <div className="mt-auto pt-4 flex items-center gap-2 border-t border-slate-100 dark:border-slate-800">
          <a
            href={listing.url}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary text-xs px-3 py-2"
          >
            Open source
          </a>
          <button
            type="button"
            onClick={handleParse}
            disabled={parsing}
            className="btn-primary text-xs px-3 py-2"
          >
            {parsing ? "Parsing…" : "Parse listing"}
          </button>
        </div>
      </div>
    </article>
  );
}

function ListingGrid({
  title,
  subtitle,
  listings,
  total,
  limit,
  empty,
  toolbar,
}: {
  title: string;
  subtitle: string;
  listings: MarketListing[];
  total: number;
  limit: number;
  empty: string;
  toolbar?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
            <span className="text-sm font-medium tabular-nums text-slate-600 dark:text-slate-300">
              {formatCount(listings.length, total, limit)}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>
        </div>
        {toolbar}
      </div>
      {listings.length === 0 ? (
        <div className="card px-5 py-10 text-center text-sm text-slate-500">{empty}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function SpecialStatementsClient() {
  const [propertyType, setPropertyType] = useState<MarketPropertyType | "">("");
  const [minutesInput, setMinutesInput] = useState("");
  const [minutesFilter, setMinutesFilter] = useState<number | null>(null);
  const [newList, setNewList] = useState<ListResponse | null>(null);
  const [specialList, setSpecialList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (propertyType) params.set("propertyType", propertyType);
    const qs = params.toString();
    return qs ? `?${qs}&` : "?";
  }, [propertyType]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const newParams = new URLSearchParams();
      if (propertyType) newParams.set("propertyType", propertyType);
      newParams.set("section", "new");
      if (minutesFilter != null) newParams.set("minutes", String(minutesFilter));

      const [newRes, specialRes] = await Promise.all([
        fetch(`/api/market/listings?${newParams.toString()}`),
        fetch(`/api/market/listings${query}section=special`),
      ]);
      if (!newRes.ok || !specialRes.ok) {
        const failed = !newRes.ok ? await newRes.json().catch(() => null) : null;
        throw new Error(failed?.error || "Failed to load cached listings");
      }
      setNewList(await newRes.json());
      setSpecialList(await specialRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [query, propertyType, minutesFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyMinutesFilter(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setMinutesFilter(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      toast.error("Enter a whole number of minutes (e.g. 10)");
      return;
    }
    setMinutesFilter(n);
  }

  const lastPolledAt = specialList?.lastPolledAt ?? newList?.lastPolledAt ?? null;
  const lastError = specialList?.lastError ?? newList?.lastError ?? null;
  const neverPolled = !lastPolledAt && !loading;

  const newSubtitle =
    minutesFilter != null
      ? `Owner listings first seen in the last ${minutesFilter} minute${minutesFilter === 1 ? "" : "s"}`
      : "Listings first seen as Owner in the default window, newest first";

  return (
    <div className="space-y-8">
      <div className="page-header">
        <div>
          <p className="section-title mb-2">Workspace</p>
          <h1 className="page-title">Special statements</h1>
          <p className="page-subtitle">
            Tbilisi for-sale listings posted by owners on myhome.ge and ss.ge. Loaded from your database cache.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPropertyType("")}
          className={cn("tag-pill cursor-pointer", propertyType === "" && "ring-2 ring-slate-900 dark:ring-white")}
        >
          All types
        </button>
        {MARKET_PROPERTY_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setPropertyType(type)}
            className={cn(
              "tag-pill cursor-pointer",
              propertyType === type && "ring-2 ring-slate-900 dark:ring-white"
            )}
          >
            {type}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-400">
        {lastPolledAt
          ? `Last worker poll ${formatWhen(lastPolledAt)}`
          : "Worker has not polled yet"}
        {lastError ? ` · Last error: ${lastError}` : ""}
      </p>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 dark:bg-red-950/40 dark:border-red-800 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {neverPolled ? (
        <div className="card flex flex-col items-center justify-center py-16 px-6 text-center">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Waiting for the first worker poll
          </h3>
          <p className="text-sm text-slate-500 mt-2 max-w-md leading-relaxed">
            Owner listings are collected in the background. Keep the worker running (`npm run worker:dev`)
            and this page will fill from MySQL — it never hits myhome.ge or ss.ge on load.
          </p>
        </div>
      ) : loading ? (
        <p className="text-sm text-slate-500">Loading cached listings…</p>
      ) : (
        <>
          <ListingGrid
            title="New owner uploads"
            subtitle={newSubtitle}
            listings={newList?.listings ?? []}
            total={newList?.total ?? 0}
            limit={newList?.limit ?? 80}
            empty={
              minutesFilter != null
                ? `No owner listings first seen in the last ${minutesFilter} minutes.`
                : "No new owner listings in the recent window."
            }
            toolbar={
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  applyMinutesFilter(minutesInput);
                }}
              >
                <label htmlFor="new-minutes" className="text-sm text-slate-500 whitespace-nowrap">
                  Last
                </label>
                <input
                  id="new-minutes"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder="e.g. 10"
                  value={minutesInput}
                  onChange={(e) => setMinutesInput(e.target.value)}
                  className="w-24 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm tabular-nums text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-white"
                />
                <span className="text-sm text-slate-500">minutes</span>
                <button type="submit" className="btn-secondary text-xs px-3 py-2">
                  Apply
                </button>
                {minutesFilter != null && (
                  <button
                    type="button"
                    className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline-offset-2 hover:underline"
                    onClick={() => {
                      setMinutesInput("");
                      setMinutesFilter(null);
                    }}
                  >
                    Clear
                  </button>
                )}
              </form>
            }
          />
          <ListingGrid
            title="Special statements"
            subtitle="Owner listings with no matching agency or agent copy"
            listings={specialList?.listings ?? []}
            total={specialList?.total ?? 0}
            limit={specialList?.limit ?? 80}
            empty="No special owner listings for this filter yet."
          />
        </>
      )}
    </div>
  );
}
