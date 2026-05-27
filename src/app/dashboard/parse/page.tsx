"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

type ParseStatus = "idle" | "queued" | "parsing" | "done" | "failed";

export default function ParsePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [parseStatus, setParseStatus] = useState<ParseStatus>("idle");
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
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
        setParseStatus("done");
        setQueuePosition(null);
        toast.success("Listing parsed successfully!");
        router.push(`/dashboard/listing/${id}`);
      } else if (data.status === "FAILED") {
        stopPolling();
        setParseStatus("failed");
        setQueuePosition(null);
        toast.error("Parsing failed. Please try again.");
      }
    } catch {
      // network error — keep polling
    }
  }, [stopPolling, router]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  async function handleParse(e: React.FormEvent) {
    e.preventDefault();
    setParseStatus("queued");
    setQueuePosition(null);
    stopPolling();

    try {
      const res = await fetch("/api/myhome/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (res.ok && data.cached) {
        router.push(`/dashboard/listing/${data.listingId}`);
        setParseStatus("idle");
        return;
      }

      if (!res.ok && res.status !== 202) {
        toast.error(data.error || "Failed to start parsing");
        setParseStatus("idle");
        return;
      }

      listingIdRef.current = data.listingId;
      setParseStatus("parsing");

      pollingRef.current = setInterval(pollStatus, 1000);
      void pollStatus();
    } catch {
      toast.error("Something went wrong");
      setParseStatus("idle");
    }
  }

  const isParsing = parseStatus === "queued" || parseStatus === "parsing";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Parse Listing</h1>
        <p className="text-gray-500 mt-1">
          Paste a myhome.ge or ss.ge listing URL and we&apos;ll extract all the data automatically.
        </p>
      </div>

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
    </div>
  );
}
