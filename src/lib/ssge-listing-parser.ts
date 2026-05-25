import "@/lib/esbuild-shim";
import { chromium, type Browser } from "playwright";
import type { MyhomeListing } from "@/lib/myhome-parser";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER_EVALUATE_SHIM =
  "globalThis.__name = globalThis.__name || function (t) { return t; };";

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

/** ss.ge listing detail sections: #details_desc and its children. */
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
  await context.addInitScript(BROWSER_EVALUATE_SHIM);
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "media" || type === "font") route.abort();
    else route.continue();
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .waitForSelector("#details_desc, h1", { timeout: 15000 })
      .catch(() => null);
    await page
      .waitForSelector("img[src*='static.ss.ge']", { timeout: 8000 })
      .catch(() => page.waitForTimeout(2000));

    await page.evaluate(BROWSER_EVALUATE_SHIM);

    const data = await page.evaluate(() => {
      const norm = (s) => s.replace(/\s+/g, " ").trim();

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

      let city = norm(addr?.cityTitle || "");
      let street = norm(addr?.streetTitle || "");
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
      let currency = "GEL";
      let pricePerSqm = "";
      if (priceData) {
        if (priceData.currencyType === 1) {
          price = String(priceData.priceUsd ?? "");
          pricePerSqm = String(priceData.unitPriceUsd ?? "");
          currency = "USD";
        } else {
          price = String(priceData.priceGeo ?? "");
          pricePerSqm = String(priceData.unitPriceGeo ?? "");
          currency = "GEL";
        }
      }

      // ---------- Images (structured data, not scraped from unrelated cards) ----------
      const appImages = app?.appImages || [];
      const images = appImages
        .map((img) => (img.fileName || "").split("?")[0])
        .filter(Boolean)
        .slice(0, 16);

      // ---------- Main specs (#details_desc overview row) ----------
      const specLabels: Record<string, string> = {};
      overviewSection?.querySelectorAll("p").forEach((labelEl) => {
        const label = norm(labelEl.textContent || "");
        const valueEl = labelEl.parentElement?.querySelector("span");
        const value = norm(valueEl?.textContent || "");
        if (!label || !value) return;

        if (/^(საერთო\s*)?ფართი$/i.test(label)) {
          const m = value.match(/([\d.]+)/);
          if (m) specLabels.area = m[1];
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
        }
      });

      // ---------- Description (only inside #details_desc) ----------
      let description = "";
      const descHeading = overviewSection?.querySelector("h2");
      if (norm(descHeading?.textContent || "") === "აღწერა") {
        const descRoot =
          descHeading.closest("section") ||
          descHeading.parentElement?.parentElement;
        if (descRoot) {
          const clone = descRoot.cloneNode(true);
          clone.querySelectorAll("h2, button, img").forEach((el) => el.remove());
          clone
            .querySelectorAll("[class*='comment'], [class*='Comment']")
            .forEach((el) => el.remove());
          description = norm(clone.textContent || "");
        }
      }

      // ---------- Detailed info (#details_main_info) ----------
      const detailFields: Record<string, string> = {};
      mainInfo?.querySelectorAll("div").forEach((div) => {
        const labelEl = div.querySelector(":scope > p");
        const valueEl = div.querySelector(":scope > h3");
        if (!labelEl || !valueEl) return;
        const label = norm(labelEl.textContent || "");
        const value = norm(valueEl.textContent || "");
        if (label && value) detailFields[label] = value;
      });

      const bathrooms = detailFields["სველი წერტილი"] || "";
      const condition = detailFields["მდგომარეობა"] || "";
      const buildingStatus = detailFields["სტატუსი"] || "";
      const projectType = detailFields["პროექტი"] || "";

      // ---------- Amenities (#additional_information, active chips only) ----------
      const rawData: Record<string, string> = {};
      additionalInfo
        ?.querySelectorAll("div[class*='sc-abd90df5-1']")
        .forEach((el) => {
          const label = norm(el.textContent || "");
          if (!label || label === "დამატებითი ინფორმაცია") return;
          const cls = el.className || "";
          if (cls.includes("cWzNVx")) return;
          if (cls.includes("hiVzfk")) rawData[label] = "კი";
        });

      if (buildingStatus) rawData["სტატუსი"] = buildingStatus;
      if (condition) rawData["მდგომარეობა"] = condition;
      if (projectType) rawData["პროექტი"] = projectType;

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

    const listing: MyhomeListing = {
      title: data.title,
      propertyType,
      dealType,
      buildingStatus: data.buildingStatus,
      condition: data.condition,
      city: data.city,
      address: data.address,
      street: data.street,
      streetNumber: data.streetNumber,
      cadastralCode: data.cadastralCode,
      price: data.price,
      pricePerSqm: data.pricePerSqm,
      currency: data.currency,
      area: data.area,
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
