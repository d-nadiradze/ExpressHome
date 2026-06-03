"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import Link from "next/link";
import ListingImageGallery from "@/components/ListingImageGallery";
import PrefillProgressPanel from "@/components/PrefillProgressPanel";

interface Listing {
  id: string;
  title: string | null;
  propertyType: string | null;
  dealType: string | null;
  buildingStatus: string | null;
  condition: string | null;
  city: string | null;
  address: string | null;
  street: string | null;
  streetNumber: string | null;
  cadastralCode: string | null;
  price: string | null;
  pricePerSqm: string | null;
  currency: string | null;
  area: string | null;
  rooms: string | null;
  bedrooms: string | null;
  floor: string | null;
  totalFloors: string | null;
  projectType: string | null;
  bathrooms: string | null;
  balconyArea: string | null;
  verandaArea: string | null;
  loggiaArea: string | null;
  description: string | null;
  images: string[] | null;
  rawData: Record<string, string> | null;
  postStatus: string;
  postUrl: string | null;
  ssgePostStatus: string;
  ssgePostUrl: string | null;
  sourceUrl: string;
  createdAt: string;
}

type GoogleAccountState = {
  googleEmail: string;
  defaultSpreadsheetId: string | null;
  defaultSheetTab: string | null;
  updatedAt: string;
};

type EditableFields = {
  title: string;
  propertyType: string;
  dealType: string;
  buildingStatus: string;
  condition: string;
  city: string;
  address: string;
  street: string;
  streetNumber: string;
  cadastralCode: string;
  price: string;
  pricePerSqm: string;
  currency: string;
  area: string;
  rooms: string;
  bedrooms: string;
  floor: string;
  totalFloors: string;
  projectType: string;
  bathrooms: string;
  balconyArea: string;
  verandaArea: string;
  loggiaArea: string;
  description: string;
};

const statusBadgeClass: Record<string, string> = {
  PARSING: "badge-parsing",
  PENDING: "badge-pending",
  POSTED: "badge-posted",
  FAILED: "badge-failed",
};

function currencySymbol(currency: string | null) {
  return currency === "GEL" ? "₾" : "$";
}

function resolveProjectType(listing: {
  projectType: string | null;
  rawData: Record<string, string> | null;
}): string | null {
  const value =
    listing.projectType?.trim() ||
    listing.rawData?.["პროექტის ტიპი"]?.trim() ||
    listing.rawData?.["პროექტი"]?.trim() ||
    "";
  return value || null;
}

const propertyTypes = ["ბინა", "კერძო სახლი", "აგარაკი", "მიწის ნაკვეთი", "კომერციული ფართი", "სასტუმრო"];
const dealTypes = ["იყიდება", "ქირავდება", "გირავდება", "ქირავდება დღიურად"];
const buildingStatuses = ["ძველი აშენებული", "ახალი აშენებული", "მშენებარე"];
const conditions = ["ახალი გარემონტებული", "ძველი გარემონტებული", "მიმდინარე რემონტი", "სარემონტო", "თეთრი კარკასი", "შავი კარკასი", "მწვანე კარკასი", "თეთრი პლიუსი"];

export default function ListingDetail({ listing: initial }: { listing: Listing }) {
  const router = useRouter();
  const [listing, setListing] = useState<Listing>(initial);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<EditableFields | null>(null);
  const [editRawData, setEditRawData] = useState<Record<string, string>>({});
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [postingMyhome, setPostingMyhome] = useState(false);
  const [postingSsge, setPostingSsge] = useState(false);
  const [exportingSheets, setExportingSheets] = useState(false);
  const [googleAccount, setGoogleAccount] = useState<GoogleAccountState | null>(null);
  const [googleLoading, setGoogleLoading] = useState(true);
  const [sheetId, setSheetId] = useState("");
  const [sheetTab, setSheetTab] = useState("Sheet1");
  const [savingSheetConfig, setSavingSheetConfig] = useState(false);
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false);
  const [prefillJob, setPrefillJob] = useState<{
    jobId: string;
    platform: "myhome" | "ssge";
  } | null>(null);
  const [reparsing, setReparsing] = useState(false);
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [descriptionEditing, setDescriptionEditing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [savingDescription, setSavingDescription] = useState(false);
  const reparsePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (reparsePollRef.current) clearInterval(reparsePollRef.current);
    };
  }, []);

  const loadGoogleAccount = useCallback(async () => {
    setGoogleLoading(true);
    try {
      const res = await fetch("/api/google/account");
      const data = await res.json();
      const account = data.account || null;
      setGoogleAccount(account);
      setSheetId(account?.defaultSpreadsheetId || "");
      setSheetTab(account?.defaultSheetTab || "Sheet1");
    } finally {
      setGoogleLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGoogleAccount();
  }, [loadGoogleAccount]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("googleConnected") === "1") {
      toast.success("Google account connected");
      void loadGoogleAccount();
      params.delete("googleConnected");
      const query = params.toString();
      window.history.replaceState({}, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
    }
    const googleError = params.get("googleError");
    if (googleError) {
      toast.error(googleError);
      params.delete("googleError");
      const query = params.toString();
      window.history.replaceState({}, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
    }
  }, [loadGoogleAccount]);

  const stopReparsePolling = useCallback(() => {
    if (reparsePollRef.current) {
      clearInterval(reparsePollRef.current);
      reparsePollRef.current = null;
    }
  }, []);

  const pollReparseStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/myhome/parse/status?listingId=${listing.id}`);
      const data = await res.json();

      if (data.status === "PENDING" || data.status === "POSTED") {
        stopReparsePolling();
        setReparsing(false);
        if (data.listing) {
          setListing(data.listing);
        }
        router.refresh();
        toast.success("Listing re-parsed successfully!");
      } else if (data.status === "FAILED") {
        stopReparsePolling();
        setReparsing(false);
        toast.error("Re-parse failed. Please try again.");
      }
    } catch {
      // keep polling
    }
  }, [listing.id, router, stopReparsePolling]);

  async function handleReparse() {
    if (
      !confirm(
        "Re-parse this listing from the source URL? Current parsed data will be refreshed."
      )
    ) {
      return;
    }

    setReparsing(true);
    stopReparsePolling();

    try {
      const res = await fetch("/api/myhome/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reparse: true, listingId: listing.id }),
      });
      const data = await res.json();

      if (!res.ok && res.status !== 202) {
        toast.error(data.error || "Failed to start re-parse");
        setReparsing(false);
        return;
      }

      reparsePollRef.current = setInterval(pollReparseStatus, 1000);
      void pollReparseStatus();
    } catch {
      toast.error("Something went wrong");
      setReparsing(false);
    }
  }

  async function handlePostMyhome() {
    if (!confirm("Start myhome.ge pre-fill? Progress will be shown step by step.")) return;
    setPostingMyhome(true);
    try {
      const res = await fetch("/api/myhome/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        toast.error(data.error || "Failed to start pre-fill");
        return;
      }
      if (data.jobId) {
        setPrefillJob({ jobId: data.jobId, platform: "myhome" });
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setPostingMyhome(false);
    }
  }

  async function handlePostSsge() {
    if (!confirm("Start ss.ge pre-fill? Progress will be shown step by step.")) return;
    setPostingSsge(true);
    try {
      const res = await fetch("/api/ssge/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        toast.error(data.error || "Failed to start pre-fill");
        return;
      }
      if (data.jobId) {
        setPrefillJob({ jobId: data.jobId, platform: "ssge" });
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setPostingSsge(false);
    }
  }

  async function handleExportGoogleSheets() {
    if (!googleAccount) {
      toast.error("Connect Google account first");
      return;
    }
    if (!sheetId.trim()) {
      toast.error("Set Spreadsheet ID first");
      return;
    }

    setExportingSheets(true);
    try {
      const res = await fetch("/api/google-sheets/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: listing.id,
          spreadsheetId: sheetId.trim(),
          sheetTab: sheetTab.trim() || "Sheet1",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to export to Google Sheets");
        return;
      }
      toast.success("Exported to Google Sheets");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setExportingSheets(false);
    }
  }

  async function handleSaveSheetConfig() {
    if (!sheetId.trim()) {
      toast.error("Spreadsheet ID is required");
      return;
    }

    setSavingSheetConfig(true);
    try {
      const res = await fetch("/api/google/account", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: sheetId.trim(),
          sheetTab: sheetTab.trim() || "Sheet1",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to save sheet settings");
        return;
      }
      toast.success("Google sheet settings saved");
      await loadGoogleAccount();
    } catch {
      toast.error("Something went wrong");
    } finally {
      setSavingSheetConfig(false);
    }
  }

  async function handleDisconnectGoogle() {
    if (!confirm("Disconnect Google account?")) return;
    setDisconnectingGoogle(true);
    try {
      const res = await fetch("/api/google/auth/disconnect", { method: "POST" });
      if (!res.ok) {
        toast.error("Failed to disconnect Google account");
        return;
      }
      toast.success("Google account disconnected");
      setGoogleAccount(null);
      setSheetId("");
      setSheetTab("Sheet1");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setDisconnectingGoogle(false);
    }
  }

  function handlePrefillComplete(postUrl?: string) {
    if (prefillJob?.platform === "myhome" && postUrl) {
      setListing((prev) => ({ ...prev, postUrl }));
    }
    if (prefillJob?.platform === "ssge" && postUrl) {
      setListing((prev) => ({ ...prev, ssgePostUrl: postUrl }));
    }
    router.refresh();
    toast.success(
      prefillJob?.platform === "ssge"
        ? "ss.ge pre-fill completed"
        : "myhome.ge pre-fill completed"
    );
  }

  function startEditing() {
    setDescriptionEditing(false);
    setDescriptionDraft("");
    setEditData({
      title: listing.title || "",
      propertyType: listing.propertyType || "",
      dealType: listing.dealType || "",
      buildingStatus: listing.buildingStatus || "",
      condition: listing.condition || "",
      city: listing.city || "",
      address: listing.address || "",
      street: listing.street || "",
      streetNumber: listing.streetNumber || "",
      cadastralCode: listing.cadastralCode || "",
      price: listing.price || "",
      pricePerSqm: listing.pricePerSqm || "",
      currency: listing.currency || "USD",
      area: listing.area || "",
      rooms: listing.rooms || "",
      bedrooms: listing.bedrooms || "",
      floor: listing.floor || "",
      totalFloors: listing.totalFloors || "",
      projectType: listing.projectType || "",
      bathrooms: listing.bathrooms || "",
      balconyArea: listing.balconyArea || "",
      verandaArea: listing.verandaArea || "",
      loggiaArea: listing.loggiaArea || "",
      description: listing.description || "",
    });
    setEditRawData({ ...(listing.rawData || {}) });
    setNewParamKey("");
    setNewParamValue("");
    setEditing(true);
  }

  async function handleSave() {
    if (!editData) return;
    setSaving(true);
    try {
      const res = await fetch("/api/myhome/parse", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: listing.id, ...editData, rawData: editRawData }),
      });
      if (!res.ok) { toast.error("Failed to save"); return; }
      setListing({ ...listing, ...editData, rawData: editRawData });
      setEditing(false);
      setEditData(null);
      toast.success("Saved!");
    } catch { toast.error("Something went wrong"); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!confirm("Delete this listing? This cannot be undone.")) return;
    try {
      const res = await fetch("/api/myhome/parse", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: listing.id }),
      });
      if (!res.ok) { toast.error("Failed to delete"); return; }
      toast.success("Listing deleted");
      router.push("/dashboard");
    } catch { toast.error("Something went wrong"); }
  }

  function addRawDataParam() {
    const key = newParamKey.trim();
    const value = newParamValue.trim();
    if (!key) return;
    setEditRawData({ ...editRawData, [key]: value });
    setNewParamKey("");
    setNewParamValue("");
  }

  function removeRawDataParam(key: string) {
    const updated = { ...editRawData };
    delete updated[key];
    setEditRawData(updated);
  }

  async function persistDescription(description: string) {
    const res = await fetch("/api/myhome/parse", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: listing.id, description }),
    });
    if (!res.ok) {
      toast.error("Failed to save description");
      return false;
    }
    setListing((prev) => ({ ...prev, description }));
    router.refresh();
    return true;
  }

  function startDescriptionEdit() {
    setDescriptionDraft(listing.description || "");
    setDescriptionEditing(true);
  }

  function cancelDescriptionEdit() {
    setDescriptionEditing(false);
    setDescriptionDraft("");
  }

  async function saveDescriptionEdit() {
    setSavingDescription(true);
    try {
      const saved = await persistDescription(descriptionDraft);
      if (saved) {
        setDescriptionEditing(false);
        setDescriptionDraft("");
        toast.success("Description saved");
      }
    } finally {
      setSavingDescription(false);
    }
  }

  async function handleImproveDescription() {
    const currentDescription = descriptionEditing
      ? descriptionDraft
      : editing && editData
        ? editData.description
        : listing.description || "";

    if (!currentDescription.trim()) {
      toast.error("Add a description first, then improve with AI");
      return;
    }

    setAiSuggesting(true);
    try {
      const res = await fetch(`/api/listings/${listing.id}/suggest-description`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentDescription,
          mode: "improve",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "AI suggestion failed", { duration: 6000 });
        return;
      }

      if (descriptionEditing) {
        setDescriptionDraft(data.description);
      } else if (editing && editData) {
        setEditData({ ...editData, description: data.description });
      } else {
        const saved = await persistDescription(data.description);
        if (!saved) return;
      }

      if (data.source === "template") {
        toast(
          data.warning || "OpenAI unavailable — kept your original description.",
          { icon: "⚠️", duration: 7000 }
        );
      } else {
        const savedMsg =
          editing || descriptionEditing ? "" : " and saved";
        toast.success("Description improved" + savedMsg);
      }
    } catch {
      toast.error("Something went wrong");
    } finally {
      setAiSuggesting(false);
    }
  }

  function renderSpecTile(
    label: string,
    value: string,
    options?: { numeric?: boolean; title?: string }
  ) {
    const fullTitle = options?.title ?? (options?.numeric ? undefined : value);
    return (
      <div className="spec-tile" title={fullTitle}>
        <p className={options?.numeric ? "spec-tile-value" : "spec-tile-value-text"}>
          {value}
        </p>
        <p className="spec-tile-label">{label}</p>
      </div>
    );
  }

  function renderDescriptionActions(
    currentDescription: string,
    options?: { showEdit?: boolean }
  ) {
    const hasDescription = Boolean(currentDescription.trim());

    return (
      <div className="flex flex-wrap gap-2 shrink-0">
        {options?.showEdit && !descriptionEditing && (
          <button
            type="button"
            onClick={startDescriptionEdit}
            className="btn-ghost text-sm border border-slate-200 dark:border-slate-700"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit
          </button>
        )}
        <button
          type="button"
          onClick={handleImproveDescription}
          disabled={aiSuggesting || !hasDescription}
          className="btn-ai text-sm"
          title={hasDescription ? undefined : "Add a description first"}
        >
          {aiSuggesting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Improving…
            </>
          ) : (
            <>
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
              </svg>
              Improve with AI
            </>
          )}
        </button>
      </div>
    );
  }

  const images = listing.images || [];
  const ed = editData || ({} as EditableFields);
  const projectTypeDisplay = resolveProjectType(listing);

  const renderField = (label: string, value: string | null) => {
    if (!value) return null;
    return (
      <div className="detail-row">
        <span className="detail-row-label">{label}</span>
        <span className="detail-row-value">{value}</span>
      </div>
    );
  };

  const renderSelect = (label: string, field: keyof EditableFields, options: string[]) => (
    <div>
      <label className="form-label">{label}</label>
      <select className="input w-full" value={ed[field]} onChange={(e) => setEditData({ ...ed, [field]: e.target.value })}>
        <option value="">--</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  const renderInput = (label: string, field: keyof EditableFields, placeholder?: string) => (
    <div>
      <label className="form-label">{label}</label>
      <input className="input w-full" placeholder={placeholder} value={ed[field]} onChange={(e) => setEditData({ ...ed, [field]: e.target.value })} />
    </div>
  );

  return (
    <>
      {prefillJob && (
        <PrefillProgressPanel
          jobId={prefillJob.jobId}
          platform={prefillJob.platform}
          onClose={() => setPrefillJob(null)}
          onComplete={handlePrefillComplete}
        />
      )}

      <div className="space-y-6">
        {/* Top bar */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 text-sm text-subtle hover:text-slate-800 dark:hover:text-slate-200 transition-colors mb-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to dashboard
            </Link>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50 line-clamp-2">
              {listing.title || "Untitled listing"}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className={`badge ${statusBadgeClass[listing.postStatus]}`} title="myhome.ge status">
                myhome · {listing.postStatus}
              </span>
              <span className={`badge ${statusBadgeClass[listing.ssgePostStatus]}`} title="ss.ge status">
                ss.ge · {listing.ssgePostStatus}
              </span>
            </div>
          </div>

          {!editing && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleReparse}
                disabled={reparsing || postingMyhome || postingSsge || editing}
                className="btn-ghost text-sm"
              >
                {reparsing ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Re-parsing…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Re-parse
                  </>
                )}
              </button>
              <button onClick={startEditing} className="btn-secondary text-sm">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
            </div>
          )}

          {editing && (
            <div className="flex gap-2">
              <button
                onClick={() => { setEditing(false); setEditData(null); }}
                className="btn-ghost text-sm"
              >
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
        </div>

        <div className={`grid gap-6 items-start ${editing ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-[1fr_320px]"}`}>
          <div className="space-y-6 min-w-0">
            <ListingImageGallery
              listingId={listing.id}
              images={images}
              onImagesChange={(newImages) => setListing({ ...listing, images: newImages })}
            />

        {editing && editData ? (
          <>
            {/* Classification */}
            <div className="card space-y-4">
              <h3 className="card-heading">Classification</h3>
              <div>
                <label className="form-label">Title</label>
                <input className="input w-full" value={ed.title} onChange={(e) => setEditData({ ...ed, title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {renderSelect("Property Type", "propertyType", propertyTypes)}
                {renderSelect("Deal Type", "dealType", dealTypes)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {renderSelect("Building Status", "buildingStatus", buildingStatuses)}
                {renderSelect("Condition", "condition", conditions)}
              </div>
            </div>

            {/* Location */}
            <div className="card space-y-4">
              <h3 className="card-heading">Location</h3>
              <div className="grid grid-cols-3 gap-3">
                {renderInput("City", "city", "თბილისი")}
                {renderInput("Street", "street", "კოსტავას")}
                {renderInput("Street Number", "streetNumber", "80")}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {renderInput("Full Address", "address")}
                {renderInput("Cadastral Code", "cadastralCode", "Optional")}
              </div>
            </div>

            {/* Price */}
            <div className="card space-y-4">
              <h3 className="card-heading">Pricing</h3>
              <div className="grid grid-cols-3 gap-3">
                {renderInput("Price", "price")}
                {renderInput("Price per m²", "pricePerSqm")}
                <div>
                  <label className="form-label">Currency</label>
                  <select className="input w-full" value={ed.currency} onChange={(e) => setEditData({ ...ed, currency: e.target.value })}>
                    <option value="USD">USD ($)</option>
                    <option value="GEL">GEL (₾)</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Specs */}
            <div className="card space-y-4">
              <h3 className="card-heading">Specifications</h3>
              <div className="grid grid-cols-3 gap-3">
                {renderInput("Area (m²)", "area")}
                {renderInput("Rooms", "rooms")}
                {renderInput("Bedrooms", "bedrooms")}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {renderInput("Floor", "floor")}
                {renderInput("Total Floors", "totalFloors")}
                {renderInput("Project Type", "projectType")}
              </div>
            </div>

            {/* Extras */}
            <div className="card space-y-4">
              <h3 className="card-heading">Additional</h3>
              <div className="grid grid-cols-4 gap-3">
                {renderInput("Bathrooms", "bathrooms")}
                {renderInput("Balcony (m²)", "balconyArea")}
                {renderInput("Veranda (m²)", "verandaArea")}
                {renderInput("Loggia (m²)", "loggiaArea")}
              </div>
            </div>

            {/* Description */}
            <div className="card space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-slate-50">Description</h3>
                  <p className="text-xs text-subtle mt-0.5">
                    Improve an existing description — removes seller info and polishes the text.
                  </p>
                </div>
                {renderDescriptionActions(ed.description)}
              </div>
              <textarea
                className="input w-full min-h-[160px] leading-relaxed"
                value={ed.description}
                onChange={(e) => setEditData({ ...ed, description: e.target.value })}
                placeholder="აღწერა myhome.ge / ss.ge-სთვის…"
              />
            </div>

            {/* Raw Data / Additional Parameters */}
            <div className="card space-y-4">
              <h3 className="card-heading">Additional Parameters (rawData)</h3>

              {Object.keys(editRawData).length > 0 && (
                <div className="space-y-2">
                  {Object.entries(editRawData).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="detail-row-label min-w-[160px] shrink-0 truncate" title={key}>{key}</span>
                      <input
                        className="input flex-1"
                        value={value}
                        onChange={(e) => setEditRawData({ ...editRawData, [key]: e.target.value })}
                      />
                      <button
                        onClick={() => removeRawDataParam(key)}
                        className="text-red-400 hover:text-red-600 shrink-0 p-1 rounded hover:bg-red-50 transition-colors"
                        title="Remove"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2 pt-2 border-t border-gray-100">
                <div className="flex-1">
                  <label className="block text-xs text-subtle mb-1">Key</label>
                  <input
                    className="input w-full"
                    placeholder="e.g. გათბობა"
                    value={newParamKey}
                    onChange={(e) => setNewParamKey(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addRawDataParam(); }}
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-subtle mb-1">Value</label>
                  <input
                    className="input w-full"
                    placeholder="e.g. კი"
                    value={newParamValue}
                    onChange={(e) => setNewParamValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addRawDataParam(); }}
                  />
                </div>
                <button
                  onClick={addRawDataParam}
                  disabled={!newParamKey.trim()}
                  className="text-sm text-white bg-gray-600 hover:bg-gray-700 px-3 py-2 rounded-md font-medium disabled:opacity-30 transition-colors shrink-0"
                >
                  Add
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Summary */}
            <div className="card space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div className="min-w-0">
                  {(listing.address || listing.city) && (
                    <p className="text-subtle flex items-start gap-2 text-sm leading-relaxed">
                      <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      {[listing.city, listing.street, listing.streetNumber].filter(Boolean).join(", ") || listing.address}
                    </p>
                  )}
                </div>
                {listing.price && (
                  <div className="sm:text-right shrink-0">
                    <p className="text-3xl font-bold tabular-nums text-slate-900 dark:text-slate-50">
                      {listing.price} {currencySymbol(listing.currency)}
                    </p>
                    {listing.pricePerSqm && (
                      <p className="text-sm text-subtle tabular-nums mt-0.5">
                        {listing.pricePerSqm} {currencySymbol(listing.currency)}/m²
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {listing.propertyType && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-600/15 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-500/25">
                    {listing.propertyType}
                  </span>
                )}
                {listing.dealType && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-violet-50 text-violet-800 ring-1 ring-inset ring-violet-600/15 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-500/25">
                    {listing.dealType}
                  </span>
                )}
                {listing.buildingStatus && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/15 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-500/25">
                    {listing.buildingStatus}
                  </span>
                )}
                {listing.condition && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/15 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-500/25">
                    {listing.condition}
                  </span>
                )}
              </div>
            </div>

            {/* Specs */}
            {(listing.area || listing.rooms || listing.bedrooms || listing.floor || listing.bathrooms || projectTypeDisplay) && (
              <div className="card">
                <h3 className="section-title mb-4">Quick specs</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                  {listing.area && renderSpecTile("m²", listing.area, { numeric: true })}
                  {listing.rooms && renderSpecTile("Rooms", listing.rooms, { numeric: true })}
                  {listing.bedrooms && renderSpecTile("Bedrooms", listing.bedrooms, { numeric: true })}
                  {listing.floor &&
                    renderSpecTile(
                      "Floor",
                      `${listing.floor}${listing.totalFloors ? `/${listing.totalFloors}` : ""}`,
                      { numeric: true }
                    )}
                  {listing.bathrooms && renderSpecTile("Bathrooms", listing.bathrooms, { numeric: true })}
                  {projectTypeDisplay && renderSpecTile("Project", projectTypeDisplay)}
                </div>
              </div>
            )}

            {/* Details */}
            <div className="card">
              <h3 className="section-title mb-2">Property details</h3>
              {renderField("Property Type", listing.propertyType)}
              {renderField("Deal Type", listing.dealType)}
              {renderField("Building Status", listing.buildingStatus)}
              {renderField("Condition", listing.condition)}
              {renderField("Project Type", projectTypeDisplay)}
              {renderField("City", listing.city)}
              {renderField("Street", listing.street)}
              {renderField("Street Number", listing.streetNumber)}
              {renderField("Owner (მესაკუთრე)", listing.rawData?.["მესაკუთრე"] || null)}
              {renderField("Mobile (ნომერი)", listing.rawData?.["ნომერი"] || null)}
              {renderField("Cadastral Code", listing.cadastralCode)}
              {renderField(
                "Price per m²",
                listing.pricePerSqm ? `${listing.pricePerSqm} ${currencySymbol(listing.currency)}` : null
              )}
              {renderField("Balcony", listing.balconyArea ? `${listing.balconyArea} m²` : null)}
              {renderField("Veranda", listing.verandaArea ? `${listing.verandaArea} m²` : null)}
              {renderField("Loggia", listing.loggiaArea ? `${listing.loggiaArea} m²` : null)}
            </div>

            {/* Description */}
            <div className="card space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div>
                  <h3 className="section-title mb-1">Description</h3>
                  <p className="text-xs text-subtle">
                    {descriptionEditing
                      ? "Edit the text, then save. Improve with AI updates the draft."
                      : "Edit manually or polish with AI. Saves automatically after AI improve."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 shrink-0">
                  {descriptionEditing ? (
                    <>
                      {renderDescriptionActions(descriptionDraft)}
                      <button
                        type="button"
                        onClick={cancelDescriptionEdit}
                        disabled={savingDescription}
                        className="btn-ghost text-sm"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={saveDescriptionEdit}
                        disabled={savingDescription}
                        className="btn-primary text-sm"
                      >
                        {savingDescription ? "Saving…" : "Save"}
                      </button>
                    </>
                  ) : (
                    renderDescriptionActions(listing.description || "", { showEdit: true })
                  )}
                </div>
              </div>
              {descriptionEditing ? (
                <textarea
                  className="input w-full min-h-[160px] leading-relaxed"
                  value={descriptionDraft}
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                  placeholder="აღწერა myhome.ge / ss.ge-სთვის…"
                />
              ) : listing.description ? (
                <p className="text-slate-600 dark:text-slate-300 text-sm leading-relaxed whitespace-pre-line">
                  {listing.description}
                </p>
              ) : (
                <p className="text-sm text-subtle italic">
                  No description yet. Click Edit to add one.
                </p>
              )}
            </div>

            {listing.rawData && Object.keys(listing.rawData).length > 0 && (
              <div className="card">
                <h3 className="section-title mb-3">Additional parameters</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                  {Object.entries(listing.rawData).map(([key, value]) => (
                    <div key={key} className="detail-row">
                      <span className="detail-row-label truncate pr-4" title={key}>{key}</span>
                      <span className="detail-row-value shrink-0">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
          </div>

          {/* Sidebar — publish & links */}
          {!editing && (
            <aside className="panel-sticky">
              <div className="card space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Publish</h3>
                  <p className="text-xs text-subtle mt-1 leading-relaxed">
                    Auto-fill listing forms on each platform step by step.
                  </p>
                </div>

                {listing.postStatus !== "POSTED" && (
                  <button
                    onClick={handlePostMyhome}
                    disabled={postingMyhome || postingSsge || exportingSheets || !!prefillJob || reparsing}
                    className="btn-success w-full text-sm"
                  >
                    {postingMyhome ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Starting myhome.ge…
                      </>
                    ) : (
                      "Pre-fill on myhome.ge"
                    )}
                  </button>
                )}

                {listing.ssgePostStatus !== "POSTED" && (
                  <button
                    onClick={handlePostSsge}
                    disabled={postingMyhome || postingSsge || exportingSheets || !!prefillJob || reparsing}
                    className="btn-platform-ssge w-full text-sm"
                  >
                    {postingSsge ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Starting ss.ge…
                      </>
                    ) : (
                      "Pre-fill on ss.ge"
                    )}
                  </button>
                )}

                {googleLoading ? (
                  <p className="text-xs text-slate-500">Loading Google status...</p>
                ) : googleAccount ? (
                  <div className="space-y-2">
                    <p className="text-xs text-slate-500 truncate" title={googleAccount.googleEmail}>
                      Google: {googleAccount.googleEmail}
                    </p>
                    <input
                      className="input w-full text-sm"
                      placeholder="Spreadsheet ID"
                      value={sheetId}
                      onChange={(e) => setSheetId(e.target.value)}
                      disabled={savingSheetConfig || exportingSheets}
                    />
                    <input
                      className="input w-full text-sm"
                      placeholder="Sheet tab (e.g. Sheet1)"
                      value={sheetTab}
                      onChange={(e) => setSheetTab(e.target.value)}
                      disabled={savingSheetConfig || exportingSheets}
                    />
                    <button
                      onClick={handleSaveSheetConfig}
                      disabled={savingSheetConfig || exportingSheets || !sheetId.trim()}
                      className="btn-ghost w-full text-sm"
                    >
                      {savingSheetConfig ? "Saving..." : "Save Google Sheet"}
                    </button>
                    <button
                      onClick={handleDisconnectGoogle}
                      disabled={disconnectingGoogle || exportingSheets}
                      className="btn-ghost w-full text-sm text-red-600"
                    >
                      {disconnectingGoogle ? "Disconnecting..." : "Disconnect Google"}
                    </button>
                  </div>
                ) : (
                  <a
                    href={`/api/google/auth/start?next=${encodeURIComponent(`/dashboard/listing/${listing.id}`)}`}
                    className="btn-secondary w-full text-sm"
                  >
                    Connect Google
                  </a>
                )}

                <button
                  onClick={handleExportGoogleSheets}
                  disabled={
                    postingMyhome ||
                    postingSsge ||
                    exportingSheets ||
                    !!prefillJob ||
                    reparsing ||
                    listing.postStatus === "PARSING" ||
                    !googleAccount ||
                    !sheetId.trim()
                  }
                  className="btn-secondary w-full text-sm"
                >
                  {exportingSheets ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Exporting…
                    </>
                  ) : (
                    "Export to Google Sheets"
                  )}
                </button>

                {listing.postStatus === "POSTED" && listing.ssgePostStatus === "POSTED" && (
                  <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-emerald-600/15">
                    Published on both platforms.
                  </p>
                )}
              </div>

              <div className="card space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Links</h3>
                <a
                  href={listing.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary w-full text-sm"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  View original
                </a>
                {listing.postUrl && (
                  <a
                    href={listing.postUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary w-full text-sm text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                  >
                    View on myhome.ge
                  </a>
                )}
                {listing.ssgePostUrl && (
                  <a
                    href={listing.ssgePostUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary w-full text-sm text-violet-700 border-violet-200 hover:bg-violet-50"
                  >
                    View on ss.ge
                  </a>
                )}
              </div>

              <button
                onClick={handleDelete}
                className="w-full inline-flex items-center justify-center gap-2 text-sm text-red-600 hover:text-red-700 font-medium px-4 py-2.5 rounded-xl border border-red-200 hover:bg-red-50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete listing
              </button>
            </aside>
          )}
        </div>
      </div>
    </>
  );
}
