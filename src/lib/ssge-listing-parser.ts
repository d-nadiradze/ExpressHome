import "@/lib/esbuild-shim";
import { chromium, type Browser } from "playwright";
import type { MyhomeListing } from "@/lib/myhome-parser";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserInstance;
}

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

export async function parseSsgeListing(url: string): Promise<{
  success: boolean;
  data?: MyhomeListing;
  error?: string;
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "ka-GE",
  });
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "media" || type === "font") route.abort();
    else route.continue();
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for the SPA to render listing content
    await page.waitForSelector("h1, h2", { timeout: 15000 }).catch(() => null);
    await page
      .waitForSelector("img[src*='static.ss.ge']", { timeout: 8000 })
      .catch(() => page.waitForTimeout(2000));

    const data = await page.evaluate(() => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();

      // ---------- Title ----------
      const h1 = document.querySelector("h1");
      const title = norm(h1?.textContent || document.title || "");

      // ---------- Address (subtitle h2 right after h1) ----------
      let address = "";
      if (h1) {
        const h2 = h1.parentElement?.querySelector("h2");
        if (h2) address = norm(h2.textContent || "");
      }
      if (!address) {
        const allH2 = document.querySelectorAll("h2");
        for (const h2 of allH2) {
          const t = norm(h2.textContent || "");
          if (t && !t.includes("აღწერა") && !t.includes("ინფორმაცია") && !t.includes("ისტორია")) {
            address = t;
            break;
          }
        }
      }

      // ---------- Images ----------
      const imgSet = new Set<string>();
      document.querySelectorAll("img").forEach((img) => {
        const src = img.src || img.getAttribute("data-src") || "";
        if (src.includes("static.ss.ge") && !src.includes("Thumb")) {
          const clean = src.split("?")[0];
          if (clean) imgSet.add(clean);
        }
      });
      // Also grab thumbnail URLs and derive full-size
      if (imgSet.size === 0) {
        document.querySelectorAll("img").forEach((img) => {
          const src = img.src || img.getAttribute("data-src") || "";
          if (src.includes("static.ss.ge")) {
            const clean = src.split("?")[0].replace("_Thumb", "");
            if (clean) imgSet.add(clean);
          }
        });
      }
      const images = [...imgSet].slice(0, 16);

      // ---------- Price & Currency ----------
      let price = "";
      let currency = "USD";
      let pricePerSqm = "";

      // Price is typically in a large text node near the ₾/$ toggle
      const allText = document.body.innerText;

      // Look for price pattern: "35,000" near ₾ or $
      const priceMatch = allText.match(
        /(\d[\d\s,.']+)\s*(?:₾|\$)/
      );
      if (priceMatch) {
        price = priceMatch[1].replace(/[\s,']/g, "").replace(/\.(?=\d{3})/g, "");
        currency = priceMatch[0].includes("₾") ? "GEL" : "USD";
      }

      // More reliable: find the price section with $ and ₾ buttons
      const priceElements = document.querySelectorAll("div, span, p");
      for (const el of priceElements) {
        const t = norm(el.textContent || "");
        // Match "35,000" as standalone number in a small element
        if (/^\d[\d\s,.]+$/.test(t) && t.length <= 15 && el.children.length === 0) {
          const parent = el.closest("div");
          if (parent) {
            const parentText = norm(parent.textContent || "");
            if (parentText.includes("$") || parentText.includes("₾")) {
              price = t.replace(/[\s,']/g, "").replace(/\.(?=\d{3})/g, "");
              // Check which currency symbol is active/visible nearby
              if (parentText.includes("$")) currency = "USD";
              break;
            }
          }
        }
      }

      // Price per sqm: "1 მ² - 412 $"
      const sqmMatch = allText.match(/1\s*მ²?\s*[-–—]\s*([\d\s,.]+)\s*(\$|₾)/);
      if (sqmMatch) {
        pricePerSqm = sqmMatch[1].replace(/[\s,']/g, "").replace(/\.(?=\d{3})/g, "");
      }

      // ---------- Specs ----------
      let area = "";
      let rooms = "";
      let bedrooms = "";
      let floor = "";
      let totalFloors = "";

      // Specs are in label/value pairs: "საერთო ფართი" → "85 მ²", "ოთახი" → "3"
      // They appear in a grid/flex container
      const specLabels: Record<string, string> = {};
      const allEls = document.querySelectorAll("div, span, p");
      for (const el of allEls) {
        const t = norm(el.textContent || "");
        if (el.children.length > 2) continue;

        if (/^(საერთო\s*)?ფართი$/i.test(t)) {
          const parent = el.closest("div");
          if (parent) {
            const val = norm(parent.textContent || "").replace(t, "").trim();
            const m = val.match(/([\d.]+)\s*მ?²?/);
            if (m) specLabels["area"] = m[1];
          }
        }
        if (/^ოთახი$/i.test(t)) {
          const parent = el.closest("div");
          if (parent) {
            const val = norm(parent.textContent || "").replace(t, "").trim();
            const m = val.match(/(\d+)/);
            if (m) specLabels["rooms"] = m[1];
          }
        }
        if (/^საძინებელი$/i.test(t)) {
          const parent = el.closest("div");
          if (parent) {
            const val = norm(parent.textContent || "").replace(t, "").trim();
            const m = val.match(/(\d+)/);
            if (m) specLabels["bedrooms"] = m[1];
          }
        }
        if (/^სართული$/i.test(t)) {
          const parent = el.closest("div");
          if (parent) {
            const val = norm(parent.textContent || "").replace(t, "").trim();
            const m = val.match(/(\d+)\s*\/\s*(\d+)/);
            if (m) {
              specLabels["floor"] = m[1];
              specLabels["totalFloors"] = m[2];
            } else {
              const single = val.match(/(\d+)/);
              if (single) specLabels["floor"] = single[1];
            }
          }
        }
      }

      area = specLabels["area"] || "";
      rooms = specLabels["rooms"] || "";
      bedrooms = specLabels["bedrooms"] || "";
      floor = specLabels["floor"] || "";
      totalFloors = specLabels["totalFloors"] || "";

      // Fallback: parse from "85m²" "3" "2" "6/9" text patterns
      if (!area) {
        const areaMatch = allText.match(/(\d+)\s*m²/);
        if (areaMatch) area = areaMatch[1];
      }
      if (!area) {
        const areaMatch2 = allText.match(/(\d+)\s*მ²/);
        if (areaMatch2) area = areaMatch2[1];
      }

      // ---------- Description ----------
      let description = "";
      // Find "აღწერა" heading, then get text content after it
      const headings = document.querySelectorAll("h2, h3, p, div");
      for (const heading of headings) {
        if (heading.children.length > 3) continue;
        const ht = norm(heading.textContent || "");
        if (ht !== "აღწერა") continue;

        // Description is in a sibling or child after the heading
        let sibling = heading.nextElementSibling;
        for (let i = 0; i < 5 && sibling; i++) {
          const txt = norm(sibling.textContent || "");
          if (txt.length > 20 && !txt.includes("დეტალური") && !txt.includes("დამატებითი")) {
            description = txt;
            break;
          }
          sibling = sibling.nextElementSibling;
        }
        if (description) break;

        // Try parent's text content (sometimes description is nested)
        const parent = heading.parentElement;
        if (parent) {
          const children = parent.querySelectorAll("h3, p, span, div");
          for (const child of children) {
            if (child === heading) continue;
            const ct = norm(child.textContent || "");
            if (ct.length > 20) {
              description = ct;
              break;
            }
          }
        }
        if (description) break;
      }

      // ---------- Building status ----------
      let buildingStatus = "";
      // Under "დეტალური ინფორმაცია" > "სტატუსი"
      for (const el of headings) {
        const t = norm(el.textContent || "");
        if (t !== "სტატუსი" && !t.startsWith("სტატუსი")) continue;
        // The value is the next sibling element's text
        let sibling = el.nextElementSibling;
        for (let i = 0; i < 3 && sibling; i++) {
          const val = norm(sibling.textContent || "");
          if (val && val !== "სტატუსი" && val.length < 40) {
            buildingStatus = val;
            break;
          }
          sibling = sibling.nextElementSibling;
        }
        if (!buildingStatus) {
          const parent = el.parentElement;
          if (parent) {
            const vals = parent.querySelectorAll("h3, p, span, div");
            for (const v of vals) {
              if (v === el) continue;
              const vt = norm(v.textContent || "");
              if (
                vt &&
                vt !== "სტატუსი" &&
                vt.length < 40 &&
                !vt.includes("დეტალური")
              ) {
                buildingStatus = vt;
                break;
              }
            }
          }
        }
        if (buildingStatus) break;
      }

      // ---------- Additional info (amenities) → rawData ----------
      const rawData: Record<string, string> = {};
      let inAdditionalSection = false;
      for (const el of document.querySelectorAll("h2, h3, div, p, span")) {
        const t = norm(el.textContent || "");

        if (t === "დამატებითი ინფორმაცია") {
          inAdditionalSection = true;
          continue;
        }
        if (inAdditionalSection && (t === "ადგილმდებარეობა" || t === "მისამართზე")) {
          inAdditionalSection = false;
          break;
        }
        if (inAdditionalSection && el.children.length <= 1) {
          if (t && t.length < 40 && t !== "დამატებითი ინფორმაცია" && t !== "სასწრაფოდ") {
            rawData[t] = "კი";
          }
        }
      }

      // Add building status to rawData too
      if (buildingStatus) {
        rawData["სტატუსი"] = buildingStatus;
      }

      // ---------- City from breadcrumbs ----------
      let city = "";
      // ss.ge has breadcrumb-like links at the bottom
      const breadcrumbLinks = document.querySelectorAll("a");
      for (const a of breadcrumbLinks) {
        const href = a.getAttribute("href") || "";
        const t = norm(a.textContent || "");
        if (href.includes("/udzravi-qoneba") && href.includes("tbilisi")) {
          city = "თბილისი";
          break;
        }
        if (href.includes("/udzravi-qoneba") && href.includes("batumi")) {
          city = "ბათუმი";
          break;
        }
        if (href.includes("/udzravi-qoneba") && href.includes("kutaisi")) {
          city = "ქუთაისი";
          break;
        }
        if (href.includes("/udzravi-qoneba") && href.includes("rustavi")) {
          city = "რუსთავი";
          break;
        }
        // Generic city detection from Georgian text in breadcrumbs
        if (
          href.includes("/udzravi-qoneba/") &&
          t &&
          !href.includes("-") &&
          t.length < 20 &&
          /[\u10A0-\u10FF]/.test(t)
        ) {
          city = t;
          break;
        }
      }

      // Fallback: extract city from address or title patterns
      if (!city) {
        const cityPatterns = [
          "თბილისი", "ბათუმი", "ქუთაისი", "რუსთავი", "ფოთი", "გორი",
          "ზუგდიდი", "თელავი", "ხაშური", "ოზურგეთი", "ქობულეთი",
          "სენაკი", "სამტრედია", "მარნეული", "წყალტუბო",
        ];
        for (const cp of cityPatterns) {
          if (title.includes(cp) || address.includes(cp) || allText.includes(cp)) {
            city = cp;
            break;
          }
        }
      }

      // ---------- Street from address ----------
      let street = "";
      let streetNumber = "";
      if (address) {
        // Address like "III კვარტალი - დიღმის მასივი 15"
        // Try to extract street number (trailing digits)
        const numMatch = address.match(/\s(\d+)\s*$/);
        if (numMatch) {
          streetNumber = numMatch[1];
          street = address.slice(0, address.length - numMatch[0].length).trim();
        } else {
          street = address;
        }
      }

      return {
        title,
        address,
        street,
        streetNumber,
        city,
        price,
        pricePerSqm,
        currency,
        area,
        rooms,
        bedrooms,
        floor,
        totalFloors,
        buildingStatus,
        description,
        images,
        rawData,
      };
    });

    // ---------- Post-processing in Node ----------
    // Infer deal type from title
    let dealType = "";
    for (const [re, dt] of DEAL_TYPE_KEYWORDS) {
      if (re.test(data.title)) {
        dealType = dt;
        break;
      }
    }

    // Infer property type from title
    let propertyType = "";
    for (const [re, pt] of PROPERTY_TYPE_KEYWORDS) {
      if (re.test(data.title)) {
        propertyType = pt;
        break;
      }
    }

    const listing: MyhomeListing = {
      title: data.title,
      propertyType,
      dealType,
      buildingStatus: data.buildingStatus,
      condition: "",
      city: data.city,
      address: data.address,
      street: data.street,
      streetNumber: data.streetNumber,
      cadastralCode: "",
      price: data.price,
      pricePerSqm: data.pricePerSqm,
      currency: data.currency,
      area: data.area,
      rooms: data.rooms,
      bedrooms: data.bedrooms,
      floor: data.floor,
      totalFloors: data.totalFloors,
      projectType: "",
      bathrooms: "",
      balconyArea: "",
      verandaArea: "",
      loggiaArea: "",
      description: data.description,
      images: data.images,
      rawData: data.rawData,
    };

    console.log(
      `[ss.ge parse] OK: "${listing.title}" — ${listing.price} ${listing.currency}, ${listing.rooms} rooms, ${listing.area} m²`
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
