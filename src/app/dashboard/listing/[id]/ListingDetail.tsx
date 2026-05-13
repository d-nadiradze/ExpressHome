"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import Link from "next/link";

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
  sourceUrl: string;
  createdAt: string;
}

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

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  POSTED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
};

const propertyTypes = ["ბინა", "კერძო სახლი", "აგარაკი", "მიწის ნაკვეთი", "კომერციული ფართი", "სასტუმრო"];
const dealTypes = ["იყიდება", "ქირავდება", "გირავდება", "ქირავდება დღიურად"];
const buildingStatuses = ["ძველი აშენებული", "ახალი აშენებული", "მშენებარე"];
const conditions = ["ახალი გარემონტებული", "ძველი გარემონტებული", "მიმდინარე რემონტი", "სარემონტო", "თეთრი კარკასი", "შავი კარკასი", "მწვანე კარკასი", "თეთრი პლიუსი"];

export default function ListingDetail({ listing: initial }: { listing: Listing }) {
  const router = useRouter();
  const [listing, setListing] = useState<Listing>(initial);
  const [imgIndex, setImgIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState<EditableFields | null>(null);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);

  async function handlePost() {
    if (!confirm("A browser will open with the form pre-filled. You can review and submit manually.")) return;
    setPosting(true);
    try {
      const res = await fetch("/api/myhome/create-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || "Failed to open form"); return; }
      toast.success("Browser opened with pre-filled form. Review and submit manually.");
    } catch { toast.error("Something went wrong"); }
    finally { setPosting(false); }
  }

  function startEditing() {
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
    setEditing(true);
  }

  async function handleSave() {
    if (!editData) return;
    setSaving(true);
    try {
      const res = await fetch("/api/myhome/parse", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: listing.id, ...editData }),
      });
      if (!res.ok) { toast.error("Failed to save"); return; }
      setListing({ ...listing, ...editData });
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

  function handleRemoveImage(index: number) {
    if (!listing.images) return;
    const newImages = listing.images.filter((_, i) => i !== index);
    setListing({ ...listing, images: newImages });
    if (imgIndex >= newImages.length) setImgIndex(Math.max(0, newImages.length - 1));
    fetch("/api/myhome/parse", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: listing.id, images: newImages }),
    }).catch(() => null);
  }

  const images = listing.images || [];
  const ed = editData || ({} as EditableFields);

  const renderField = (label: string, value: string | null) => {
    if (!value) return null;
    return (
      <div className="flex justify-between py-2 border-b border-gray-100">
        <span className="text-sm text-gray-500">{label}</span>
        <span className="text-sm font-medium text-gray-900">{value}</span>
      </div>
    );
  };

  const renderSelect = (label: string, field: keyof EditableFields, options: string[]) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select className="input w-full" value={ed[field]} onChange={(e) => setEditData({ ...ed, [field]: e.target.value })}>
        <option value="">--</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  const renderInput = (label: string, field: keyof EditableFields, placeholder?: string) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input className="input w-full" placeholder={placeholder} value={ed[field]} onChange={(e) => setEditData({ ...ed, [field]: e.target.value })} />
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm -mx-6 -mt-6 px-6 py-3 border-b border-gray-200 flex items-center justify-between">
        <Link href="/dashboard" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </Link>
        <div className="flex items-center gap-2">
          {!editing ? (
            <>
              <button onClick={startEditing} className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 px-2.5 py-1.5 rounded-md hover:bg-blue-50 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
              {listing.postStatus !== "POSTED" && (
                <button
                  onClick={handlePost}
                  disabled={posting}
                  className="text-sm text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                >
                  {posting ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Opening form...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      Pre-fill on myhome.ge
                    </>
                  )}
                </button>
              )}
            </>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => { setEditing(false); setEditData(null); }} className="text-sm text-gray-500 hover:text-gray-700 font-medium px-2.5 py-1.5">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="text-sm text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          )}
          <span className={`badge ${statusColors[listing.postStatus]}`}>{listing.postStatus}</span>
        </div>
      </div>

      {/* Image gallery */}
      {images.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="relative aspect-video bg-gray-100">
            <img src={images[imgIndex]} alt={listing.title || ""} className="w-full h-full object-cover" />
            {images.length > 1 && (
              <>
                <button
                  onClick={() => setImgIndex((i) => Math.max(0, i - 1))}
                  className="absolute left-3 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-9 h-9 flex items-center justify-center"
                >&#8249;</button>
                <button
                  onClick={() => setImgIndex((i) => Math.min(images.length - 1, i + 1))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-9 h-9 flex items-center justify-center"
                >&#8250;</button>
                <div className="absolute bottom-3 right-3 bg-black/40 text-white text-xs px-2 py-1 rounded">
                  {imgIndex + 1} / {images.length}
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2 p-3 overflow-x-auto">
            {images.map((img, i) => (
              <div key={i} className="relative shrink-0 group">
                <button
                  onClick={() => setImgIndex(i)}
                  className={`w-16 h-12 rounded overflow-hidden border-2 transition-colors ${i === imgIndex ? "border-blue-500" : "border-transparent"}`}
                >
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </button>
                <button
                  onClick={() => handleRemoveImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove image"
                >&times;</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && editData ? (
        <>
          {/* Classification */}
          <div className="card space-y-4">
            <h3 className="font-semibold text-gray-900">Classification</h3>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
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
            <h3 className="font-semibold text-gray-900">Location</h3>
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
            <h3 className="font-semibold text-gray-900">Pricing</h3>
            <div className="grid grid-cols-3 gap-3">
              {renderInput("Price", "price")}
              {renderInput("Price per m²", "pricePerSqm")}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select className="input w-full" value={ed.currency} onChange={(e) => setEditData({ ...ed, currency: e.target.value })}>
                  <option value="USD">USD ($)</option>
                  <option value="GEL">GEL (₾)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Specs */}
          <div className="card space-y-4">
            <h3 className="font-semibold text-gray-900">Specifications</h3>
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
            <h3 className="font-semibold text-gray-900">Additional</h3>
            <div className="grid grid-cols-4 gap-3">
              {renderInput("Bathrooms", "bathrooms")}
              {renderInput("Balcony (m²)", "balconyArea")}
              {renderInput("Veranda (m²)", "verandaArea")}
              {renderInput("Loggia (m²)", "loggiaArea")}
            </div>
          </div>

          {/* Description */}
          <div className="card space-y-4">
            <h3 className="font-semibold text-gray-900">Description</h3>
            <textarea className="input w-full min-h-[120px]" value={ed.description} onChange={(e) => setEditData({ ...ed, description: e.target.value })} />
          </div>
        </>
      ) : (
        <>
          {/* Title + Price header */}
          <div className="card space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold text-gray-900">{listing.title || "Untitled"}</h2>
                {listing.address && (
                  <p className="text-gray-500 mt-1 flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {[listing.city, listing.street, listing.streetNumber].filter(Boolean).join(", ") || listing.address}
                  </p>
                )}
              </div>
              {listing.price && (
                <div className="text-right shrink-0">
                  <p className="text-2xl font-bold text-blue-600">{listing.price} {listing.currency === "GEL" ? "₾" : "$"}</p>
                  {listing.pricePerSqm && (
                    <p className="text-sm text-gray-400">{listing.pricePerSqm} {listing.currency === "GEL" ? "₾" : "$"}/m²</p>
                  )}
                </div>
              )}
            </div>

            {/* Tags row */}
            <div className="flex flex-wrap gap-2">
              {listing.propertyType && <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-medium">{listing.propertyType}</span>}
              {listing.dealType && <span className="px-2.5 py-1 rounded-full bg-purple-50 text-purple-700 text-xs font-medium">{listing.dealType}</span>}
              {listing.buildingStatus && <span className="px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium">{listing.buildingStatus}</span>}
              {listing.condition && <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-medium">{listing.condition}</span>}
            </div>
          </div>

          {/* Specs grid */}
          <div className="card">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-4 text-center">
              {listing.area && (
                <div>
                  <p className="text-lg font-semibold text-gray-900">{listing.area}</p>
                  <p className="text-xs text-gray-500">m²</p>
                </div>
              )}
              {listing.rooms && (
                <div>
                  <p className="text-lg font-semibold text-gray-900">{listing.rooms}</p>
                  <p className="text-xs text-gray-500">Rooms</p>
                </div>
              )}
              {listing.bedrooms && (
                <div>
                  <p className="text-lg font-semibold text-gray-900">{listing.bedrooms}</p>
                  <p className="text-xs text-gray-500">Bedrooms</p>
                </div>
              )}
              {listing.floor && (
                <div>
                  <p className="text-lg font-semibold text-gray-900">
                    {listing.floor}{listing.totalFloors ? `/${listing.totalFloors}` : ""}
                  </p>
                  <p className="text-xs text-gray-500">Floor</p>
                </div>
              )}
              {listing.bathrooms && (
                <div>
                  <p className="text-lg font-semibold text-gray-900">{listing.bathrooms}</p>
                  <p className="text-xs text-gray-500">Bathrooms</p>
                </div>
              )}
              {listing.projectType && (
                <div>
                  <p className="text-sm font-semibold text-gray-900">{listing.projectType}</p>
                  <p className="text-xs text-gray-500">Project</p>
                </div>
              )}
            </div>
          </div>

          {/* Details */}
          <div className="card space-y-1">
            <h3 className="font-semibold text-gray-900 mb-3">Details</h3>
            {renderField("Property Type", listing.propertyType)}
            {renderField("Deal Type", listing.dealType)}
            {renderField("Building Status", listing.buildingStatus)}
            {renderField("Condition", listing.condition)}
            {renderField("City", listing.city)}
            {renderField("Street", listing.street)}
            {renderField("Street Number", listing.streetNumber)}
            {renderField("Cadastral Code", listing.cadastralCode)}
            {renderField("Price per m²", listing.pricePerSqm ? `${listing.pricePerSqm} ${listing.currency === "GEL" ? "₾" : "$"}` : null)}
            {renderField("Balcony", listing.balconyArea ? `${listing.balconyArea} m²` : null)}
            {renderField("Veranda", listing.verandaArea ? `${listing.verandaArea} m²` : null)}
            {renderField("Loggia", listing.loggiaArea ? `${listing.loggiaArea} m²` : null)}
          </div>

          {/* Description */}
          {listing.description && (
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-2">Description</h3>
              <p className="text-gray-600 text-sm whitespace-pre-line">{listing.description}</p>
            </div>
          )}

          {/* Raw data */}
          {listing.rawData && Object.keys(listing.rawData).length > 0 && (
            <div className="card">
              <h3 className="font-semibold text-gray-900 mb-2">Additional Parameters</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {Object.entries(listing.rawData).map(([key, value]) => (
                  <div key={key} className="flex justify-between py-1.5 border-b border-gray-100 text-sm">
                    <span className="text-gray-500">{key}</span>
                    <span className="font-medium text-gray-900">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          <a href={listing.sourceUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary text-sm flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            View Original
          </a>
          {listing.postUrl && (
            <a href={listing.postUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary text-sm flex items-center gap-2 text-green-700 border-green-200">
              View Posted
            </a>
          )}
        </div>
        <button
          onClick={handleDelete}
          className="text-sm text-red-600 hover:text-red-700 font-medium flex items-center gap-1 px-3 py-2 rounded-lg hover:bg-red-50 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Delete
        </button>
      </div>
    </div>
  );
}
