"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import toast from "react-hot-toast";
import ListingImageGallery from "@/components/ListingImageGallery";

interface ParsedListing {
  id: string;
  title: string;
  price: string;
  currency: string;
  description: string;
  address: string;
  area: string;
  rooms: string;
  floor: string;
  totalFloors: string;
  images: string[];
  rawData: Record<string, string>;
  postStatus: string;
  ssgePostStatus: string;
}

type ParseStatus = "idle" | "queued" | "parsing" | "done" | "failed";

export default function ParsePage() {
  const [url, setUrl] = useState("");
  const [parseStatus, setParseStatus] = useState<ParseStatus>("idle");
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishingSsge, setPublishingSsge] = useState(false);
  const [saving, setSaving] = useState(false);
  const [listing, setListing] = useState<ParsedListing | null>(null);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<ParsedListing>>({});
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listingIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async () => {
    const id = listingIdRef.current;
    if (!id) return;

    try {
      const res = await fetch(`/api/myhome/parse/status?listingId=${id}`);
      const data = await res.json();

      if (data.status === "PARSING") {
        setParseStatus(data.queuePosition ? "queued" : "parsing");
        setQueuePosition(data.queuePosition);
      } else if (data.status === "PENDING" || data.status === "POSTED") {
        stopPolling();
        setListing(data.listing);
        setParseStatus("done");
        setQueuePosition(null);
        toast.success("Listing parsed successfully!");
      } else if (data.status === "FAILED") {
        stopPolling();
        setParseStatus("failed");
        setQueuePosition(null);
        toast.error("Parsing failed. Please try again.");
      }
    } catch {
      // network error — keep polling
    }
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  async function handleParse(e: React.FormEvent) {
    e.preventDefault();
    setParseStatus("queued");
    setListing(null);
    setEditing(false);
    setQueuePosition(null);
    stopPolling();

    try {
      const res = await fetch("/api/myhome/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok && res.status !== 202) {
        toast.error(data.error || "Failed to start parsing");
        setParseStatus("idle");
        return;
      }

      listingIdRef.current = data.listingId;
      setParseStatus("parsing");

      pollingRef.current = setInterval(pollStatus, 3000);
      // First poll immediately
      setTimeout(pollStatus, 500);
    } catch {
      toast.error("Something went wrong");
      setParseStatus("idle");
    }
  }

  function startEditing() {
    if (!listing) return;
    setEditData({
      title: listing.title,
      price: listing.price,
      currency: listing.currency,
      description: listing.description,
      address: listing.address,
      area: listing.area,
      rooms: listing.rooms,
      floor: listing.floor,
      totalFloors: listing.totalFloors,
    });
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setEditData({});
  }

  async function handleSave() {
    if (!listing) return;
    setSaving(true);

    try {
      const res = await fetch("/api/myhome/parse", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: listing.id, ...editData }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to save");
        return;
      }

      setListing({ ...listing, ...editData } as ParsedListing);
      setEditing(false);
      setEditData({});
      toast.success("Changes saved!");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!listing) return;
    setPublishing(true);

    try {
      const res = await fetch("/api/myhome/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to publish post");
        return;
      }

      toast.success("myhome.ge form opened. Review and submit manually.");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setPublishing(false);
    }
  }

  async function handlePublishSsge() {
    if (!listing) return;
    setPublishingSsge(true);

    try {
      const res = await fetch("/api/ssge/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to publish post");
        return;
      }

      toast.success("ss.ge form opened. Review and submit manually.");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setPublishingSsge(false);
    }
  }

  const isParsing = parseStatus === "queued" || parseStatus === "parsing";
  const images = listing?.images || [];
  const displayValue = (field: keyof ParsedListing) =>
    editing ? (editData[field] as string) ?? "" : (listing?.[field] as string) ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Parse Listing</h1>
        <p className="text-gray-500 mt-1">
          Paste a myhome.ge or ss.ge listing URL and we&apos;ll extract all the data automatically.
        </p>
      </div>

      {/* URL input form */}
      <div className="card">
        <form onSubmit={handleParse} className="flex gap-3">
          <input
            type="url"
            className="input flex-1"
            placeholder="https://www.myhome.ge/pr/... or https://home.ss.ge/ka/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <button
            type="submit"
            className="btn-primary whitespace-nowrap flex items-center gap-2"
            disabled={isParsing}
          >
            {isParsing ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Parsing...
              </>
            ) : (
              "Parse"
            )}
          </button>
        </form>
        <p className="text-xs text-gray-400 mt-2">
          Example: https://www.myhome.ge/pr/24724106/... or https://home.ss.ge/ka/udzravi-qoneba/...
        </p>
      </div>

      {/* Queue / progress indicator */}
      {isParsing && (
        <div className="card flex items-center gap-4">
          <div className="relative">
            <svg className="animate-spin h-8 w-8 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <div>
            {parseStatus === "queued" && queuePosition ? (
              <>
                <p className="font-medium text-gray-900">Queued — position {queuePosition}</p>
                <p className="text-sm text-gray-500">Waiting for other parses to finish...</p>
              </>
            ) : (
              <>
                <p className="font-medium text-gray-900">Parsing listing...</p>
                <p className="text-sm text-gray-500">Extracting data from listing (this takes 15-30 seconds)</p>
              </>
            )}
          </div>
        </div>
      )}

      {parseStatus === "failed" && (
        <div className="card border-red-200 bg-red-50">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="font-medium text-red-800">Parsing failed</p>
              <p className="text-sm text-red-600">The listing could not be parsed. Check the URL and try again.</p>
            </div>
          </div>
        </div>
      )}

      {/* Parsed listing result */}
      {listing && parseStatus === "done" && (
        <div className="space-y-4">
          <ListingImageGallery
            listingId={listing.id}
            images={images}
            onImagesChange={(newImages) =>
              setListing((prev) => (prev ? { ...prev, images: newImages } : null))
            }
          />

          {/* Details (view / edit mode) */}
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Listing Details</h2>
              {!editing ? (
                <button onClick={startEditing} className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelEditing} className="text-sm text-gray-500 hover:text-gray-700 font-medium">
                    Cancel
                  </button>
                  <button onClick={handleSave} disabled={saving} className="text-sm text-white bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded-md font-medium disabled:opacity-50">
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              )}
            </div>

            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                  <input
                    className="input w-full"
                    value={displayValue("title")}
                    onChange={(e) => setEditData({ ...editData, title: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Price</label>
                    <input
                      className="input w-full"
                      value={displayValue("price")}
                      onChange={(e) => setEditData({ ...editData, price: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                    <select
                      className="input w-full"
                      value={displayValue("currency")}
                      onChange={(e) => setEditData({ ...editData, currency: e.target.value })}
                    >
                      <option value="USD">USD</option>
                      <option value="GEL">GEL</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                    <input
                      className="input w-full"
                      value={displayValue("address")}
                      onChange={(e) => setEditData({ ...editData, address: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Rooms</label>
                    <input
                      className="input w-full"
                      value={displayValue("rooms")}
                      onChange={(e) => setEditData({ ...editData, rooms: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Area</label>
                    <input
                      className="input w-full"
                      value={displayValue("area")}
                      onChange={(e) => setEditData({ ...editData, area: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Floor</label>
                    <input
                      className="input w-full"
                      value={displayValue("floor")}
                      onChange={(e) => setEditData({ ...editData, floor: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Total Floors</label>
                    <input
                      className="input w-full"
                      value={displayValue("totalFloors")}
                      onChange={(e) => setEditData({ ...editData, totalFloors: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    className="input w-full min-h-[100px]"
                    value={displayValue("description")}
                    onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">{listing.title}</h2>
                    {listing.address && (
                      <p className="text-gray-500 mt-1 flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        {listing.address}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-bold text-blue-600">
                      {listing.price} {listing.currency}
                    </p>
                  </div>
                </div>

                {/* Property specs */}
                <div className="grid grid-cols-3 gap-4 py-4 border-t border-b border-gray-100">
                  {listing.rooms && (
                    <div className="text-center">
                      <p className="text-lg font-semibold text-gray-900">{listing.rooms}</p>
                      <p className="text-xs text-gray-500">Rooms</p>
                    </div>
                  )}
                  {listing.area && (
                    <div className="text-center">
                      <p className="text-lg font-semibold text-gray-900">{listing.area}</p>
                      <p className="text-xs text-gray-500">Area</p>
                    </div>
                  )}
                  {listing.floor && (
                    <div className="text-center">
                      <p className="text-lg font-semibold text-gray-900">
                        {listing.floor}{listing.totalFloors ? `/${listing.totalFloors}` : ""}
                      </p>
                      <p className="text-xs text-gray-500">Floor</p>
                    </div>
                  )}
                </div>

                {/* Description */}
                {listing.description && (
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Description</h3>
                    <p className="text-gray-600 text-sm whitespace-pre-line">
                      {listing.description}
                    </p>
                  </div>
                )}

                {/* Raw data */}
                {Object.keys(listing.rawData || {}).length > 0 && (
                  <div>
                    <h3 className="font-medium text-gray-900 mb-2">Property Details</h3>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(listing.rawData).map(([key, value]) => (
                        <div key={key} className="flex justify-between py-1 border-b border-gray-50 text-sm">
                          <span className="text-gray-500">{key}</span>
                          <span className="font-medium text-gray-900">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              View Original
            </a>

            <button
              onClick={handlePublish}
              className="btn-primary flex items-center gap-2"
              disabled={publishing || publishingSsge || editing}
            >
              {publishing ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Opening myhome.ge...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Pre-fill on myhome.ge
                </>
              )}
            </button>

            <button
              onClick={handlePublishSsge}
              className="btn-primary !bg-indigo-600 hover:!bg-indigo-700 flex items-center gap-2"
              disabled={publishing || publishingSsge || editing}
            >
              {publishingSsge ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Opening ss.ge...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Pre-fill on ss.ge
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
