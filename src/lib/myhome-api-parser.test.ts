/**
 * Run: npx tsx src/lib/myhome-api-parser.test.ts
 */
import assert from "node:assert/strict";
import { selectMyhomeImageUrls } from "./myhome-api-parser";

const cdn = "https://static-api-statements.tnet.ge/uploads/202609/20260922/statements";

// Regression: `large` carries the myhome.ge watermark — only `thumb` may be stored.
{
  const urls = selectMyhomeImageUrls([
    { large: `${cdn}/a.webp`, thumb: `${cdn}/a_thumb.webp`, blur: `${cdn}/a_blur.webp`, is_main: true },
    { large: `${cdn}/b.webp`, thumb: `${cdn}/b_thumb.webp` },
  ]);
  assert.deepEqual(urls, [`${cdn}/a_thumb.webp`, `${cdn}/b_thumb.webp`]);
  assert.ok(urls.every((u) => /_thumb\.webp$/.test(u)), "every stored URL must be the thumb rendition");
}

// An entry without a thumb is dropped rather than falling back to the watermarked large.
{
  const urls = selectMyhomeImageUrls([{ large: `${cdn}/only-large.webp` }, { thumb: `${cdn}/c_thumb.webp` }]);
  assert.deepEqual(urls, [`${cdn}/c_thumb.webp`]);
}

// Capped at 16 photos; tolerant of missing input.
{
  const many = Array.from({ length: 20 }, (_, i) => ({ thumb: `${cdn}/p${i}_thumb.webp` }));
  assert.equal(selectMyhomeImageUrls(many).length, 16);
  assert.deepEqual(selectMyhomeImageUrls(undefined), []);
  assert.deepEqual(selectMyhomeImageUrls(null), []);
}

console.log("myhome-api-parser tests passed");
