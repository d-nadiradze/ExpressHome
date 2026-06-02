"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";

const MAX_IMAGES = 16;

interface ListingImageGalleryProps {
  listingId: string;
  images: string[];
  onImagesChange: (images: string[]) => void;
}

export default function ListingImageGallery({
  listingId,
  images,
  onImagesChange,
}: ListingImageGalleryProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  async function persistImages(nextImages: string[], errorMessage: string) {
    try {
      const res = await fetch("/api/myhome/parse", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: listingId, images: nextImages }),
      });
      if (!res.ok) {
        toast.error(errorMessage);
      }
    } catch {
      toast.error(errorMessage);
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;

    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      toast.error(`Maximum ${MAX_IMAGES} images allowed`);
      return;
    }

    const toUpload = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      toast.error(`Only ${remaining} more image(s) can be added (max ${MAX_IMAGES})`);
    }

    const formData = new FormData();
    toUpload.forEach((f) => formData.append("files", f));

    setUploading(true);
    try {
      const res = await fetch(`/api/myhome/listings/${listingId}/images`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to upload images");
        return;
      }
      const updated = (data.images as string[]) || [...images, ...(data.urls as string[])];
      onImagesChange(updated);
      toast.success(`Added ${toUpload.length} photo(s)`);
    } catch {
      toast.error("Failed to upload images");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleRemove(index: number) {
    const newImages = images.filter((_, i) => i !== index);
    onImagesChange(newImages);
    if (currentIndex >= newImages.length) {
      setCurrentIndex(Math.max(0, newImages.length - 1));
    }
    void persistImages(newImages, "Failed to save image removal");
  }

  function reorderImages(from: number, to: number): string[] {
    if (from === to || from < 0 || to < 0 || from >= images.length || to >= images.length) {
      return images;
    }
    const next = [...images];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }

  function handleDropAt(targetIndex: number) {
    if (draggedIndex == null) return;
    const next = reorderImages(draggedIndex, targetIndex);
    if (next === images) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    onImagesChange(next);
    setCurrentIndex((prev) => {
      if (prev === draggedIndex) return targetIndex;
      if (draggedIndex < prev && targetIndex >= prev) return prev - 1;
      if (draggedIndex > prev && targetIndex <= prev) return prev + 1;
      return prev;
    });

    setDraggedIndex(null);
    setDragOverIndex(null);
    void persistImages(next, "Failed to save photo order");
  }

  const canAddMore = images.length < MAX_IMAGES;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="relative aspect-video bg-gray-100 flex items-center justify-center">
        {images.length > 0 ? (
          <>
            <img
              src={images[currentIndex]}
              alt=""
              className="w-full h-full object-cover"
            />
            {images.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                  className="absolute left-3 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-9 h-9 flex items-center justify-center"
                >
                  &#8249;
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCurrentIndex((i) => Math.min(images.length - 1, i + 1))
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white rounded-full w-9 h-9 flex items-center justify-center"
                >
                  &#8250;
                </button>
                <div className="absolute bottom-3 right-3 bg-black/40 text-white text-xs px-2 py-1 rounded">
                  {currentIndex + 1} / {images.length}
                </div>
              </>
            )}
          </>
        ) : (
          <p className="text-gray-400 text-sm">No photos yet</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 p-3 border-t border-gray-100">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
        {canAddMore && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium px-3 py-1.5 border border-blue-200 rounded-md disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Add photos"}
          </button>
        )}
        <span className="text-xs text-gray-400">
          {images.length}/{MAX_IMAGES} (JPG, PNG, WebP)
        </span>
      </div>

      {images.length > 0 && (
        <div className="flex gap-2 px-3 pb-3 overflow-x-auto">
          {images.map((img, i) => (
            <div
              key={`${img}-${i}`}
              className={`relative shrink-0 group ${
                dragOverIndex === i ? "ring-2 ring-blue-400 rounded-md" : ""
              }`}
              draggable
              onDragStart={() => {
                setDraggedIndex(i);
                setDragOverIndex(i);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverIndex !== i) setDragOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDropAt(i);
              }}
              onDragEnd={() => {
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}
            >
              <button
                type="button"
                onClick={() => setCurrentIndex(i)}
                className={`w-16 h-12 rounded overflow-hidden border-2 transition-colors ${
                  i === currentIndex ? "border-blue-500" : "border-transparent"
                }`}
              >
                <img src={img} alt="" className="w-full h-full object-cover" />
              </button>
              <button
                type="button"
                onClick={() => handleRemove(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remove image"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      {images.length > 1 && (
        <div className="px-3 pb-3">
          <p className="text-xs text-gray-400">Tip: drag thumbnails left/right to reorder photos.</p>
        </div>
      )}
    </div>
  );
}
