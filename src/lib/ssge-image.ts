/**
 * ss.ge listing image helpers.
 *
 * ss.ge serves listing photos from `static.ss.ge` with the "ss.ge" watermark
 * baked into the default `fileName` (and `_Thumb`) variants. The same photo is
 * available without the watermark at the `_Original` variant. These helpers
 * convert between the two so parsed/re-posted photos carry no ss.ge banner.
 */

const SSGE_STATIC =
  /^(https:\/\/static\.ss\.ge\/.+?)(?:_Thumb|_Original)?\.jpg(\?.*)?$/i;

/**
 * Watermark-free ss.ge variant of a static image URL, or null when the URL is
 * not an ss.ge static `.jpg` image.
 */
export function ssgeOriginalImageUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(SSGE_STATIC);
  return m ? `${m[1]}_Original.jpg` : null;
}

/**
 * Watermarked (base) ss.ge variant of an `_Original` URL, or null when the URL
 * is not an ss.ge `_Original` image. Used as a download fallback.
 */
export function ssgeWatermarkedImageUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/^(https:\/\/static\.ss\.ge\/.+?)_Original\.jpg(\?.*)?$/i);
  return m ? `${m[1]}.jpg` : null;
}
