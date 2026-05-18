import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import os from "os";

export const MAX_LISTING_IMAGES = 16;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function getUploadDir(): string {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "data", "uploads");
}

export function imageApiPath(listingId: string, fileId: string): string {
  return `/api/myhome/listings/${listingId}/images?fileId=${fileId}`;
}

export function parseUploadedImageUrl(
  url: string
): { listingId: string; fileId: string } | null {
  const match = url.match(
    /^\/api\/myhome\/listings\/([^/]+)\/images\?fileId=([^&]+)$/
  );
  if (!match) return null;
  return { listingId: match[1], fileId: match[2] };
}

export function isUploadedImageUrl(url: string): boolean {
  return parseUploadedImageUrl(url) !== null;
}

export function listingImageDiskPath(
  userId: string,
  listingId: string,
  fileId: string,
  ext: string
): string {
  return path.join(getUploadDir(), userId, listingId, `${fileId}.${ext}`);
}

export async function ensureUploadDir(
  userId: string,
  listingId: string
): Promise<string> {
  const dir = path.join(getUploadDir(), userId, listingId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function validateImageFile(file: File): string | null {
  if (!ALLOWED_MIME.has(file.type)) {
    return "Only JPG, PNG, and WebP images are allowed";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Each image must be 10MB or smaller";
  }
  return null;
}

export async function saveListingImage(
  userId: string,
  listingId: string,
  file: File
): Promise<{ fileId: string; url: string; ext: string }> {
  const err = validateImageFile(file);
  if (err) throw new Error(err);

  const ext = EXT_BY_MIME[file.type] || "jpg";
  const fileId = randomUUID();
  await ensureUploadDir(userId, listingId);
  const diskPath = listingImageDiskPath(userId, listingId, fileId, ext);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(diskPath, buffer);

  return {
    fileId,
    ext,
    url: imageApiPath(listingId, fileId),
  };
}

export async function readListingImageFile(
  userId: string,
  listingId: string,
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const dir = path.join(getUploadDir(), userId, listingId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const match = entries.find((name) => name.startsWith(`${fileId}.`));
  if (!match) return null;

  const ext = match.split(".").pop()?.toLowerCase();
  const mimeType =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : "image/jpeg";

  const buffer = await fs.readFile(path.join(dir, match));
  return { buffer, mimeType };
}

function extFromContentType(contentType: string | null): string {
  if (!contentType) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
    if (pathname.endsWith(".jpeg") || pathname.endsWith(".jpg")) return "jpg";
  } catch {
    /* ignore */
  }
  return "jpg";
}

async function downloadRemoteImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": FETCH_USER_AGENT },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`Failed to download image ${url}: ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type");
    const ext = extFromContentType(contentType) || extFromUrl(url);
    const buffer = Buffer.from(await res.arrayBuffer());

    if (buffer.length > MAX_IMAGE_BYTES) {
      console.warn(`Image too large, skipping: ${url}`);
      return null;
    }

    const tempPath = path.join(
      os.tmpdir(),
      `myhome-img-${randomUUID()}.${ext}`
    );
    await fs.writeFile(tempPath, buffer);
    return tempPath;
  } catch (e) {
    console.warn(`Failed to download image ${url}:`, e);
    return null;
  }
}

async function resolveUploadedImagePath(
  url: string,
  userId: string
): Promise<string | null> {
  const parsed = parseUploadedImageUrl(url);
  if (!parsed) return null;

  const dir = path.join(getUploadDir(), userId, parsed.listingId);
  try {
    const entries = await fs.readdir(dir);
    const match = entries.find((name) => name.startsWith(`${parsed.fileId}.`));
    if (!match) return null;
    return path.join(dir, match);
  } catch {
    return null;
  }
}

export async function resolveImagesForPlaywright(
  images: string[],
  listingId: string,
  userId: string
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tempPaths: string[] = [];
  const paths: string[] = [];

  for (const url of images.slice(0, MAX_LISTING_IMAGES)) {
    if (isUploadedImageUrl(url)) {
      const diskPath = await resolveUploadedImagePath(url, userId);
      if (diskPath) paths.push(diskPath);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      const tempPath = await downloadRemoteImage(url);
      if (tempPath) {
        paths.push(tempPath);
        tempPaths.push(tempPath);
      }
    }
  }

  return {
    paths,
    cleanup: async () => {
      await Promise.all(
        tempPaths.map((p) => fs.unlink(p).catch(() => undefined))
      );
    },
  };
}
