/**
 * myhome.ge parser: photo rendition selection, statement mapping and the
 * listing-page fallback.
 *
 * Run: npx tsx src/lib/myhome-api-parser.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.SSGE_BROWSER_FALLBACK = "false";
process.env.SSGE_CURL_FALLBACK = "false";

const STATEMENT = {
  id: 26293614,
  price: { "1": { price_total: 351068, price_square: 4388 }, "2": { price_total: 135000, price_square: 1688 } },
  currency_id: 2,
  deal_type_id: 1,
  real_estate_type_id: 1,
  city_name: "თბილისი",
  district_name: "ვაკე-საბურთალო",
  address: "თ. იოსებიძის ქ. 59",
  area: 80,
  floor: 3,
  total_floors: 8,
  room_type_id: 4,
  bedroom_type_id: 2,
  condition: "ძველი გარემონტებული",
  comment: "იყიდება 80 კვადრატი ბინა<br>ორი საძინებლით",
  dynamic_title: "იყიდება 4 ოთახიანი ბინა საბურთალოზე",
  owner_name: "maia",
  user_phone_number: "579550***",
  parameters: [{ id: 10, key: "furniture", display_name: "ავეჯი" }],
  images: [
    { large: "https://static/l1.webp", thumb: "https://static/t1.webp", blur: "https://static/b1.webp" },
    { large: "https://static/l2.webp", thumb: "https://static/t2.webp" },
  ],
};

function pageHtml(statement: unknown): string {
  const next = {
    props: {
      pageProps: {
        statementId: "26293614",
        dehydratedState: {
          queries: [
            { queryKey: ["cardView"], state: { data: "list" } },
            {
              queryKey: ["statements", "details", { locale: "ka", statementId: "26293614" }],
              state: { data: { result: true, data: { statement } } },
            },
          ],
        },
      },
    },
    buildId: "63AgDeMXHJ85W5Uf7x9sg",
  };
  return `<!DOCTYPE html><html><head></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></body></html>`;
}

async function main() {
  const {
    mapMyhomeStatement,
    extractMyhomeStatementFromHtml,
    parseMyhomeViaApi,
    selectMyhomeImageUrls,
  } = await import("./myhome-api-parser");

  // ---- photo renditions -----------------------------------------------------
  {
    const cdn = "https://static-api-statements.tnet.ge/uploads/202609/20260922/statements";
    // Regression: `large` carries the myhome.ge watermark — only `thumb` may be stored.
    const urls = selectMyhomeImageUrls([
      { large: `${cdn}/a.webp`, thumb: `${cdn}/a_thumb.webp`, blur: `${cdn}/a_blur.webp`, is_main: true },
      { large: `${cdn}/b.webp`, thumb: `${cdn}/b_thumb.webp` },
    ]);
    assert.deepEqual(urls, [`${cdn}/a_thumb.webp`, `${cdn}/b_thumb.webp`]);
    assert.ok(urls.every((u) => /_thumb\.webp$/.test(u)), "every stored URL must be the thumb rendition");
    // No thumb → dropped rather than falling back to the watermarked large.
    assert.deepEqual(
      selectMyhomeImageUrls([{ large: `${cdn}/only-large.webp` }, { thumb: `${cdn}/c_thumb.webp` }]),
      [`${cdn}/c_thumb.webp`]
    );
    // Capped at 16; tolerant of missing input.
    const many = Array.from({ length: 20 }, (_, i) => ({ thumb: `${cdn}/p${i}_thumb.webp` }));
    assert.equal(selectMyhomeImageUrls(many).length, 16);
    assert.deepEqual(selectMyhomeImageUrls(undefined), []);
    assert.deepEqual(selectMyhomeImageUrls(null), []);
    console.log("ok thumb renditions only");
  }

  // ---- mapper ---------------------------------------------------------------
  {
    const l = mapMyhomeStatement(STATEMENT);
    assert.ok(l);
    assert.equal(l.title, "იყიდება 4 ოთახიანი ბინა საბურთალოზე");
    assert.equal(l.price, "135000");
    assert.equal(l.currency, "USD");
    assert.equal(l.pricePerSqm, "1688");
    assert.equal(l.area, "80");
    assert.equal(l.floor, "3");
    assert.equal(l.totalFloors, "8");
    assert.equal(l.city, "თბილისი");
    assert.equal(l.address, "თ. იოსებიძის ქ. 59");
    assert.deepEqual(l.images, ["https://static/t1.webp", "https://static/t2.webp"], "thumb renditions only");
    assert.equal(l.description, "იყიდება 80 კვადრატი ბინა\nორი საძინებლით");
    assert.equal(l.rawData["ავეჯი"], "კი");
    assert.equal(l.rawData["რაიონი"], "ვაკე-საბურთალო");
    assert.equal(mapMyhomeStatement(null), null);
    assert.equal(mapMyhomeStatement({ id: 1 }), null, "no title and no price → unusable");
    console.log("ok statement mapper");
  }

  // ---- __NEXT_DATA__ extraction ----------------------------------------------
  {
    const s = extractMyhomeStatementFromHtml(pageHtml(STATEMENT), "26293614");
    assert.equal(s?.id, 26293614);
    assert.equal(extractMyhomeStatementFromHtml("<html>no data</html>"), null);
    assert.equal(
      extractMyhomeStatementFromHtml('<script id="__NEXT_DATA__">{broken</script>'),
      null
    );
    console.log("ok __NEXT_DATA__ extraction");
  }

  // ---- end to end: API rejects → page fallback → cooldown skips API ----------
  const apiCalls: string[] = [];
  const pageCalls: string[] = [];
  const realFetch = globalThis.fetch;
  const server = createServer((req, res) => {
    pageCalls.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml(STATEMENT));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api-statements.tnet.ge/")) {
      apiCalls.push(url);
      return new Response('{"result":false,"errors":["Unauthorized"]}', {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://www.myhome.ge/")) {
      return realFetch(url.replace("https://www.myhome.ge", `http://127.0.0.1:${port}`), init);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const r1 = await parseMyhomeViaApi("https://www.myhome.ge/pr/26293614/");
    assert.equal(r1.success, true, r1.error);
    assert.equal(r1.data?.title, "იყიდება 4 ოთახიანი ბინა საბურთალოზე");
    assert.equal(r1.data?.images.length, 2);
    assert.equal(apiCalls.length, 1, "API tried once");
    assert.deepEqual(pageCalls, ["/pr/26293614/"]);

    const r2 = await parseMyhomeViaApi(
      "https://www.myhome.ge/udzravi-qoneba/iyideba-4-otaxiani-bina-saburtaloze-26293614/"
    );
    assert.equal(r2.success, true, r2.error);
    assert.equal(apiCalls.length, 1, "API skipped while parked after the 401");
    assert.equal(pageCalls.length, 2);
    console.log("ok API 401 → listing page fallback, API parked afterwards");
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }

  console.log("myhome-api-parser tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
