import "@/lib/esbuild-shim";
import type { MyhomeListing } from "@/lib/myhome-parser";
import { sanitizeBuildingStatusValue } from "@/lib/building-status-sanitize";
import { resolveListingDisplayArea } from "@/lib/listing-area";
import { blockParseResources, getParseBrowser } from "@/lib/parse-browser";
import { ssgeOriginalImageUrl } from "@/lib/ssge-image";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER_EVALUATE_SHIM =
  "globalThis.__name = globalThis.__name || function (t) { return t; };";

const PARSE_GOTO_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);
const PARSE_DATA_WAIT_MS = parseInt(process.env.PARSE_DATA_WAIT_MS || "6000", 10);

const DEAL_TYPE_KEYWORDS: [RegExp, string][] = [
  [/ქირავდება\s+დღიურად/i, "ქირავდება დღიურად"],
  [/ქირავდება/i, "ქირავდება"],
  [/იყიდება/i, "იყიდება"],
  [/გირავდება/i, "გირავდება"],
];

const PROPERTY_TYPE_KEYWORDS: [RegExp, string][] = [
  [/კერძო\s*სახლი/i, "კერძო სახლი"],
  [/მიწის\s*ნაკვეთი/i, "მიწის ნაკვეთი"],
  [/კომერციული\s*ფართი/i, "კომერციული ფართი"],
  [/კომერციული/i, "კომერციული ფართი"],
  [/სასტუმრო/i, "სასტუმრო"],
  [/აგარაკი/i, "აგარაკი"],
  [/ბინა/i, "ბინა"],
];

/** ss.ge listing detail sections: #details_desc and its children. */
/** @deprecated Use parseSsgeListingViaFetch from ssge-fetch-parser.ts instead. */
export async function parseSsgeListing(url: string): Promise<{
  success: boolean;
  data?: MyhomeListing;
  error?: string;
}> {
  const browser = await getParseBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "ka-GE",
  });
  await context.addInitScript(BROWSER_EVALUATE_SHIM);
  await context.route("**/*", blockParseResources);
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PARSE_GOTO_MS });
    await page
      .waitForFunction(() => {
        const raw = document.querySelector("#__NEXT_DATA__")?.textContent;
        if (!raw) return false;
        try {
          const app =
            JSON.parse(raw)?.props?.pageProps?.applicationData ?? null;
          return Boolean(app?.title || app?.appImages?.length);
        } catch {
          return false;
        }
      }, { timeout: PARSE_DATA_WAIT_MS })
      .catch(() =>
        page.waitForSelector("#details_desc, h1", { timeout: 2500 }).catch(() => null)
      );

    await page.evaluate(BROWSER_EVALUATE_SHIM);

    const data = await page.evaluate(() => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();

      let app = null;
      try {
        const nextRaw = document.querySelector("#__NEXT_DATA__")?.textContent;
        if (nextRaw) {
          app =
            JSON.parse(nextRaw)?.props?.pageProps?.applicationData ?? null;
        }
      } catch {
        app = null;
      }

      const detailsDesc = document.querySelector("#details_desc");
      const mainInfo = document.querySelector("#details_main_info");
      const additionalInfo = document.querySelector("#additional_information");
      const overviewSection = detailsDesc?.querySelector(":scope > div:first-child");

      // ---------- Title / address / price (page-level, not in #details_desc) ----------
      const addr = app?.address || null;
      const priceData = app?.price || null;

      const title = norm(
        app?.title ||
          document.querySelector("h1")?.textContent ||
          document.title ||
          ""
      );

      let city = norm(
        addr?.cityTitle || addr?.cityName || addr?.city || ""
      );
      if (!city && title) {
        const cityInTitle = title.match(/([\u10A0-\u10FF]+)ში\b/u);
        if (cityInTitle) city = norm(cityInTitle[1]);
      }
      let street = norm(addr?.streetTitle || addr?.street || "");
      let streetNumber = norm(addr?.streetNumber || "");
      let address = "";
      if (street) {
        address = streetNumber ? `${street} ${streetNumber}` : street;
      } else {
        const h1 = document.querySelector("h1");
        const h2 = h1?.parentElement?.querySelector("h2");
        address = norm(h2?.textContent || "");
        if (address && !street) street = address;
      }

      let price = "";
      let currency = "USD";
      let pricePerSqm = "";
      if (priceData) {
        const usdPrice = priceData.priceUsd;
        const gelPrice = priceData.priceGeo;
        const usdNum =
          usdPrice != null && String(usdPrice).trim() !== ""
            ? Number(usdPrice)
            : 0;
        const gelNum =
          gelPrice != null && String(gelPrice).trim() !== ""
            ? Number(gelPrice)
            : 0;

        // Prefer USD (ss.ge API always has both; listing display currency may be GEL).
        if (usdNum > 0) {
          price = String(usdPrice);
          pricePerSqm = String(priceData.unitPriceUsd ?? "");
          currency = "USD";
        } else if (gelNum > 0) {
          price = String(gelPrice);
          pricePerSqm = String(priceData.unitPriceGeo ?? "");
          currency = "GEL";
        }
      }

      // ---------- Images (structured data, not scraped from unrelated cards) ----------
      const appImages = app?.appImages || [];
      const images = appImages
        .map((img: { fileName?: string }) => (img.fileName || "").split("?")[0])
        .filter(Boolean)
        .slice(0, 16);

      // ---------- Main specs (#details_desc overview row) ----------
      const specLabels: Record<string, string> = {};
      overviewSection?.querySelectorAll("p").forEach((labelEl) => {
        const label = norm(labelEl.textContent || "");
        const valueEl = labelEl.parentElement?.querySelector("span");
        const value = norm(valueEl?.textContent || "");
        if (!label || !value) return;

        const areaM = value.match(/([\d.,]+)/);
        if (/^(საერთო\s*)?ფართი$/i.test(label)) {
          if (areaM) specLabels.area = areaM[1].replace(",", ".");
        } else if (/^სახლის\s*ფართი$/i.test(label)) {
          if (areaM) specLabels.houseArea = areaM[1].replace(",", ".");
        } else if (/^ეზოს\s*ფართი$/i.test(label)) {
          if (areaM) specLabels.yardArea = areaM[1].replace(",", ".");
        } else if (/^ოთახი$/i.test(label)) {
          const m = value.match(/(\d+)/);
          if (m) specLabels.rooms = m[1];
        } else if (/^საძინებელი$/i.test(label)) {
          const m = value.match(/(\d+)/);
          if (m) specLabels.bedrooms = m[1];
        } else if (/^სართული$/i.test(label)) {
          const m = value.match(/(\d+)\s*\/\s*(\d+)/);
          if (m) {
            specLabels.floor = m[1];
            specLabels.totalFloors = m[2];
          } else {
            const single = value.match(/(\d+)/);
            if (single) specLabels.floor = single[1];
          }
        } else if (/^მიწის\s*ნაკვეთი$/i.test(label)) {
          specLabels.landPlotType = value;
        }
      });

      // ---------- Description (only inside #details_desc) ----------
      let description = "";
      const descHeading = overviewSection?.querySelector("h2");
      if (norm(descHeading?.textContent || "") === "აღწერა") {
        const descRoot =
          descHeading?.closest("section") ||
          descHeading?.parentElement?.parentElement;
        if (descRoot) {
          const clone = descRoot.cloneNode(true) as Element;
          clone.querySelectorAll("h2, button, img").forEach((el) => el.remove());
          clone
            .querySelectorAll("[class*='comment'], [class*='Comment']")
            .forEach((el) => el.remove());
          description = norm(clone.textContent || "");
        }
      }

      // ---------- Detailed info (p label + h3 value blocks) ----------
      const detailFields: Record<string, string> = {};

      const collectDetailPair = (labelEl: Element | null, valueEl: Element | null) => {
        const label = norm(labelEl?.textContent || "");
        const value = norm(valueEl?.textContent || "");
        if (!label || !value || value.length > 120) return;
        if (label.length > 60) return;
        detailFields[label] = value;
      };

      const detailRoots = [
        mainInfo,
        detailsDesc,
        document.querySelector("#details_desc"),
      ].filter((x): x is Element => Boolean(x));

      for (const root of detailRoots) {
        root.querySelectorAll("div").forEach((div) => {
          const labelEl = div.querySelector(":scope > p");
          const valueEl = div.querySelector(":scope > h3");
          if (labelEl && valueEl) collectDetailPair(labelEl, valueEl);
        });

        root.querySelectorAll("p").forEach((labelEl) => {
          const label = norm(labelEl.textContent || "");
          if (!label || label.length > 60) return;
          const valueEl =
            labelEl.nextElementSibling?.tagName === "H3"
              ? labelEl.nextElementSibling
              : labelEl.parentElement?.querySelector(":scope > h3");
          if (valueEl) collectDetailPair(labelEl, valueEl);
        });
      }

      const bathrooms = detailFields["სველი წერტილი"] || "";
      const condition = detailFields["მდგომარეობა"] || "";
      const commercialType = detailFields["კომერციული ფართის ტიპი"] || "";
      let landPlotType =
        specLabels.landPlotType ||
        detailFields["მიწის ნაკვეთი"] ||
        "";
      let buildingStatus = detailFields["სტატუსი"] || "";

      if (!landPlotType) {
        for (const p of document.querySelectorAll("p")) {
          const label = norm(p.textContent || "");
          if (label !== "მიწის ნაკვეთი") continue;
          const span =
            p.parentElement?.querySelector("span") ||
            (p.nextElementSibling?.tagName === "SPAN"
              ? p.nextElementSibling
              : null);
          const val = norm(span?.textContent || "");
          if (val && val !== "მიწის ნაკვეთი") {
            landPlotType = val;
            break;
          }
        }
      }

      if (app?.landType != null && !landPlotType) {
        const landById: Record<number, string> = {
          1: "სასოფლო-სამეურნეო მიწა",
          2: "არასასოფლო-სამეურნეო მიწა",
          3: "კომერციული მიწა",
          4: "სპეციალური მიწა",
          5: "საინვესტიციო მიწა",
          6: "ფერმერული მიწა",
        };
        const id = Number(app.landType);
        if (landById[id]) landPlotType = landById[id];
      }

      const landTypeLabels = new Set([
        "სასოფლო-სამეურნეო მიწა",
        "არასასოფლო-სამეურნეო მიწა",
        "კომერციული მიწა",
        "სპეციალური მიწა",
        "საინვესტიციო მიწა",
        "ფერმერული მიწა",
      ]);
      const isLandType = (v: string) => landTypeLabels.has(norm(v || ""));

      if (isLandType(buildingStatus) && !landPlotType) {
        landPlotType = buildingStatus;
        buildingStatus = "";
      } else if (isLandType(landPlotType)) {
        /* keep landPlotType only */
      } else if (landPlotType && !isLandType(landPlotType)) {
        landPlotType = "";
      }

      // ---------- Amenities (#additional_information, active toggles only) ----------
      const rawData: Record<string, string> = {};

      const markActiveAmenity = (label: string) => {
        if (!label || label === "დამატებითი ინფორმაცია" || label.length > 50) return;
        let key = label;
        const compact = label.replace(/\s+/g, "").replace(/ცენტრ\./g, "ცენტ.");
        if (compact.includes("ცენტ") && compact.includes("გათბობა")) {
          key = "ცენტ.გათბობა";
        }
        rawData[key] = "კი";
      };

      const collectActiveAmenities = (root: Element | null) => {
        if (!root) return;
        root.querySelectorAll("div").forEach((el) => {
          const p = el.querySelector(":scope > p");
          if (!p) return;
          const label = norm(p.textContent || "");
          const icon = el.querySelector(
            "span[class*='icon-add_circle'], span[class*='icon-check_circle']"
          );
          if (!icon) return;
          const active =
            el.classList.contains("active") ||
            el.querySelector("span[class*='check_circle-fill']") ||
            (el.className || "").includes("hiVzfk");
          if (active) markActiveAmenity(label);
        });
      };

      collectActiveAmenities(additionalInfo);

      // Legacy listing markup (styled-components class names)
      additionalInfo
        ?.querySelectorAll("div[class*='sc-abd90df5-1']")
        .forEach((el) => {
          const label = norm(el.textContent || "");
          if (!label || label === "დამატებითი ინფორმაცია") return;
          const cls = el.className || "";
          if (cls.includes("cWzNVx")) return;
          if (cls.includes("hiVzfk")) markActiveAmenity(label);
        });

      const extractAreaDigits = (s: unknown) => {
        const m = norm(String(s || "")).match(/([\d]+(?:[.,]\d+)?)/);
        return m ? m[1].replace(",", ".") : "";
      };

      const projectType =
        detailFields["პროექტი"] || detailFields["პროექტის ტიპი"] || "";

      if (landPlotType && isLandType(landPlotType)) {
        rawData["მიწის ნაკვეთი"] = landPlotType;
      }
      if (commercialType) {
        rawData["კომერციული ფართის ტიპი"] = commercialType;
      }
      if (buildingStatus) rawData["სტატუსი"] = buildingStatus;
      if (condition) rawData["მდგომარეობა"] = condition;
      if (projectType) {
        rawData["პროექტი"] = projectType;
        rawData["პროექტის ტიპი"] = projectType;
      }

      const kitchenArea = extractAreaDigits(detailFields["სამზარეულოს ფართი"]);
      if (kitchenArea) rawData["სამზარეულოს ფართი"] = kitchenArea;

      const viewChipLabels = [
        "ხედი ეზოზე",
        "ხედი ქუჩაზე",
        "ნათელი",
        "მყუდრო",
        "მცხელო",
      ];
      const activeViews = [];
      const viewRoots = [detailsDesc, additionalInfo, document.body];
      for (const view of viewChipLabels) {
        let found = false;
        for (const root of viewRoots) {
          if (!root || found) break;
          for (const el of root.querySelectorAll("p, span, div, h3, button")) {
            if (norm(el.textContent || "") !== view) continue;
            activeViews.push(view);
            found = true;
            break;
          }
        }
      }
      if (activeViews.length) {
        rawData["ხედი"] = [...new Set(activeViews)].join(", ");
      }

      let houseArea =
        specLabels.houseArea ||
        extractAreaDigits(detailFields["სახლის ფართი"]) ||
        "";
      let yardArea =
        specLabels.yardArea ||
        extractAreaDigits(detailFields["ეზოს ფართი"]) ||
        "";

      if (app && typeof app === "object") {
        const appNum = (v: unknown) => extractAreaDigits(v);
        const tryKeys = (keys: string[]) => {
          for (const k of keys) {
            if (app[k] != null && app[k] !== "") {
              const n = appNum(app[k]);
              if (n) return n;
            }
          }
          return "";
        };
        const estateType = norm(String(app.realEstateType || ""));
        const isHouseLike =
          /კერძო\s*სახლი|აგარაკი|სახლ/i.test(estateType) ||
          /კერძო\s*სახლი|აგარაკი|სახლ/i.test(title);

        if (!houseArea && isHouseLike) {
          houseArea = tryKeys([
            "houseArea",
            "houseSquare",
            "houseSquareMeter",
            "buildingArea",
            "homeArea",
            "totalSquare",
            "squareMeter",
            "area",
            "totalArea",
          ]);
        }
        if (!yardArea && isHouseLike) {
          yardArea = tryKeys([
            "yardArea",
            "yardSquare",
            "yardSquareMeter",
            "gardenArea",
            "gardenSquare",
            "landArea",
          ]);
        }
      }

      if (houseArea) {
        rawData["სახლის ფართი"] = houseArea;
        const estateTypeForArea = norm(String(app?.realEstateType || ""));
        if (/კერძო\s*სახლი|აგარაკი/i.test(estateTypeForArea)) {
          specLabels.area = houseArea;
        } else if (!specLabels.area) {
          specLabels.area = houseArea;
        }
      }
      if (yardArea) rawData["ეზოს ფართი"] = yardArea;

      // --- Owner name + mobile number (ss.ge contact block) ---
      // Example (web page text, may vary): "555 11 50 29 Achiko"
      let ownerName = "";
      let mobileNumber = "";
      const bodyLines = (document.body.innerText || "")
        .split(/\n+/)
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        const digits = line.replace(/\D/g, "");
        // Typical ss.ge mobile: 9 digits starting with 5.
        if (digits.length !== 9 || !digits.startsWith("5")) continue;
        mobileNumber = digits;

        const afterPhone = line.replace(digits, "").trim();
        const nameToken =
          afterPhone.match(/[A-Za-z\u10A0-\u10FF][A-Za-z\u10A0-\u10FF\-]{1,30}/u)?.[0] ||
          "";

        if (nameToken) ownerName = nameToken;
        if (!ownerName && bodyLines[i + 1]) {
          const next = bodyLines[i + 1];
          const nextToken =
            next.match(/[A-Za-z\u10A0-\u10FF][A-Za-z\u10A0-\u10FF\-]{1,30}/u)?.[0] ||
            "";
          if (nextToken) ownerName = nextToken;
        }
        break;
      }

      // Fallback: pick first Georgian mobile-like number anywhere in text.
      if (!mobileNumber) {
        const fullText = (document.body.innerText || "").replace(/\s+/g, " ");
        const m = fullText.match(/(?:\+995\s*)?(5[\d\s\-]{8,})/u);
        if (m) mobileNumber = m[1].replace(/\D/g, "");
      }

      // Expose in rawData so existing “parser view” UIs show it without wiring.
      if (ownerName) rawData["მესაკუთრე"] = ownerName;
      if (mobileNumber) rawData["ნომერი"] = mobileNumber;

      return {
        title,
        address,
        street,
        streetNumber,
        city,
        price,
        pricePerSqm,
        currency,
        area: specLabels.area || "",
        rooms: specLabels.rooms || "",
        bedrooms: specLabels.bedrooms || "",
        floor: specLabels.floor || "",
        totalFloors: specLabels.totalFloors || "",
        buildingStatus,
        condition,
        projectType,
        bathrooms,
        description,
        images,
        rawData,
        cadastralCode: norm(String(app?.cadastralCode || "")),
        propertyType: norm(String(app?.realEstateType || "")),
        dealType: norm(String(app?.realEstateDealType || "")),
        ownerName,
        mobileNumber,
      };
    });

    let dealType = data.dealType;
    if (!dealType) {
      for (const [re, dt] of DEAL_TYPE_KEYWORDS) {
        if (re.test(data.title)) {
          dealType = dt;
          break;
        }
      }
    }

    let propertyType = data.propertyType;
    if (!propertyType) {
      for (const [re, pt] of PROPERTY_TYPE_KEYWORDS) {
        if (re.test(data.title)) {
          propertyType = pt;
          break;
        }
      }
    }

    // Prefer ss.ge watermark-free `_Original` image variants.
    const images = (data.images || []).map(
      (url: string) => ssgeOriginalImageUrl(url) ?? url
    );

    const buildingStatus = sanitizeBuildingStatusValue(data.buildingStatus || "");
    if (data.rawData?.["სტატუსი"]) {
      data.rawData["სტატუსი"] = sanitizeBuildingStatusValue(data.rawData["სტატუსი"]);
    }

    const listing: MyhomeListing = {
      title: data.title,
      propertyType,
      dealType,
      buildingStatus,
      condition: data.condition,
      city: data.city,
      address: data.address,
      street: data.street,
      streetNumber: data.streetNumber,
      cadastralCode: data.cadastralCode,
      price: data.price,
      pricePerSqm: data.pricePerSqm,
      currency: data.currency,
      area: resolveListingDisplayArea(data.area, propertyType, data.rawData),
      rooms: data.rooms,
      bedrooms: data.bedrooms,
      floor: data.floor,
      totalFloors: data.totalFloors,
      projectType: data.projectType,
      bathrooms: data.bathrooms,
      balconyArea: "",
      verandaArea: "",
      loggiaArea: "",
      description: data.description,
      images,
      rawData: data.rawData,
      ownerName: data.ownerName || "",
      mobileNumber: data.mobileNumber || "",
    };

    const yardLog = listing.rawData?.["ეზოს ფართი"]
      ? `, yard ${listing.rawData["ეზოს ფართი"]} m²`
      : "";
    const houseLog = listing.rawData?.["სახლის ფართი"]
      ? ` (house ${listing.rawData["სახლის ფართი"]} m²)`
      : "";
    console.log(
      `[ss.ge parse] OK: "${listing.title}" — ${listing.price} ${listing.currency}, ${listing.rooms} rooms, ${listing.area} m²${houseLog}${yardLog}`
    );
    return { success: true, data: listing };
  } catch (error) {
    console.error("[ss.ge parse] failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "ss.ge parse failed",
    };
  } finally {
    await context.close().catch(() => null);
  }
  
}


