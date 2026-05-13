import { chromium, type Browser, type Page } from "playwright";

export interface MyhomeListing {
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
  images: string[];
  rawData: Record<string, string>;
}

export interface MyhomeCredentials {
  email: string;
  password: string;
}

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

// Login to myhome.ge with user's credentials
export async function loginToMyhome(credentials: MyhomeCredentials): Promise<{
  success: boolean;
  cookies?: string;
  error?: string;
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // Navigate to TNET auth page (myhome.ge redirects here)
    await page.goto("https://auth.tnet.ge/ka/user/login/?Continue=https://www.myhome.ge/", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Fill in email (TNET uses name="Email" with type="text")
    await page.waitForSelector('input[name="Email"]', {
      timeout: 10000,
    });
    await page.fill('input[name="Email"]', credentials.email);

    // Fill in password
    await page.fill('input[name="Password"]', credentials.password);

    // Submit login form and wait for redirect away from auth.tnet.ge
    await page.click('[data-testid="login-form__button-submit"]');
    try {
      await page.waitForURL((url) => !url.href.includes("auth.tnet.ge"), {
        timeout: 20000,
      });
    } catch {
      return { success: false, error: "Invalid credentials or login failed" };
    }

    // Save cookies for future requests
    const cookies = await context.cookies();
    const cookieString = JSON.stringify(cookies);

    return { success: true, cookies: cookieString };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Login failed",
    };
  } finally {
    await context.close();
  }
}

// Parse a myhome.ge listing page
export async function parseListing(url: string): Promise<{
  success: boolean;
  data?: MyhomeListing;
  error?: string;
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "ka-GE",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for the SPA to render listing content
    await page.waitForSelector("h1, h3", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(5000);

    const data = await page.evaluate(() => {
      // --- Images (main swiper gallery only, skip thumbnail strip) ---
      const mainSwiper = document.querySelector(".swiper:not(.swiper-thumbs)");
      const imageElements = mainSwiper
        ? mainSwiper.querySelectorAll(".swiper-slide:not(.swiper-slide-duplicate) img")
        : document.querySelectorAll(".swiper-slide:not(.swiper-slide-duplicate) img");
      const images: string[] = [];
      const seenPaths = new Set<string>();

      imageElements.forEach((img) => {
        const src =
          (img as HTMLImageElement).src ||
          (img as HTMLElement).getAttribute("data-src") || "";
        if (!src || src.includes("placeholder") || src.includes("data:")) return;
        try {
          const key = new URL(src).origin + new URL(src).pathname;
          if (seenPaths.has(key)) return;
          seenPaths.add(key);
        } catch {
          if (seenPaths.has(src)) return;
          seenPaths.add(src);
        }
        images.push(src);
      });

      // --- Title ---
      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector("h3")?.textContent?.trim() ||
        document.title;

      // --- Deal type from title ---
      let dealType = "";
      const dealMap: [string, string][] = [
        ["ქირავდება დღიურად", "ქირავდება დღიურად"],
        ["იყიდება", "იყიდება"],
        ["ქირავდება", "ქირავდება"],
        ["გირავდება", "გირავდება"],
      ];
      for (const [keyword, value] of dealMap) {
        if (title.includes(keyword)) { dealType = value; break; }
      }

      // --- Property type from title ---
      let propertyType = "";
      const propMap: [string, string][] = [
        ["კერძო სახლი", "კერძო სახლი"],
        ["სახლი", "კერძო სახლი"],
        ["აგარაკი", "აგარაკი"],
        ["მიწის ნაკვეთი", "მიწის ნაკვეთი"],
        ["კომერციული ფართი", "კომერციული ფართი"],
        ["კომერციული", "კომერციული ფართი"],
        ["სასტუმრო", "სასტუმრო"],
        ["ბინა", "ბინა"],
        ["ბინის", "ბინა"],
      ];
      const lowerTitle = title.toLowerCase();
      for (const [keyword, value] of propMap) {
        if (lowerTitle.includes(keyword.toLowerCase())) { propertyType = value; break; }
      }

      // --- Price + Currency ---
      let price = "";
      let currency = "GEL";
      const currEl = document.querySelector("[class*='currency-gel'], [class*='currency-usd']");
      if (currEl) {
        currency = currEl.className.includes("usd") ? "USD" : "GEL";
        const priceParent = currEl.parentElement;
        if (priceParent) {
          const allText = priceParent.textContent?.trim() || "";
          const m = allText.match(/(\d[\d\s,.]*)/);
          if (m) price = m[1].replace(/\s/g, "").trim();
        }
      }
      if (!price) {
        document.querySelectorAll("div, span").forEach((el) => {
          if (price) return;
          const t = el.textContent?.trim() || "";
          if (t.length > 20 || (el as HTMLElement).children.length > 2) return;
          const m = t.match(/^(\d[\d,.]*)\s*[₾$]?$/);
          if (m) price = m[1];
        });
      }

      // --- Address (full text, then split into parts) ---
      let address = "";
      document.querySelectorAll("span").forEach((sp) => {
        if (address) return;
        const t = sp.textContent?.trim() || "";
        if ((t.includes("ქ.") || t.includes("ქუჩა")) && t.length > 3 && t.length < 150) {
          address = t;
        }
      });

      let city = "";
      let street = "";
      let streetNumber = "";

      if (address) {
        // Try to parse "კოსტავას ქ. 80" -> street=კოსტავას, number=80
        const addrMatch = address.match(/^(.+?)\s+ქ\.\s*(\d+.*)$/);
        if (addrMatch) {
          street = addrMatch[1].trim();
          streetNumber = addrMatch[2].trim();
        } else {
          const streetMatch = address.match(/^(.+?)\s+ქუჩა\s*(\d+.*)$/);
          if (streetMatch) {
            street = streetMatch[1].trim();
            streetNumber = streetMatch[2].trim();
          } else {
            street = address;
          }
        }
      }

      // Extract city from breadcrumb or title context
      const cities = ["თბილისი", "ბათუმი", "ქუთაისი", "რუსთავი", "ზუგდიდი", "თელავი", "გორი", "ფოთი", "ხაშური", "ოზურგეთი", "ქობულეთი", "ბაკურიანი"];
      const pageText = document.body.textContent || "";
      for (const c of cities) {
        if (pageText.includes(c)) { city = c; break; }
      }

      // --- Specs: area, rooms, bedrooms, floor ---
      let area = "";
      let rooms = "";
      let bedrooms = "";
      let floor = "";
      let totalFloors = "";
      const rawData: Record<string, string> = {};

      const specLabels = ["ფართი", "ოთახი", "საძინებელი", "სართული"];
      document.querySelectorAll("div").forEach((container) => {
        const children = Array.from(container.children);
        if (children.length < 2 || children.length > 4) return;
        const texts = children.map((c) => c.textContent?.trim() || "");

        for (const label of specLabels) {
          if (!texts.includes(label)) continue;
          for (const sibling of texts) {
            if (sibling === label) continue;
            if (label === "ფართი" && sibling.includes("მ²") && !area) {
              area = sibling.replace(/მ²/g, "").trim();
            }
            if (label === "ოთახი" && /^\d+$/.test(sibling) && !rooms) {
              rooms = sibling;
            }
            if (label === "საძინებელი" && /^\d+$/.test(sibling) && !bedrooms) {
              bedrooms = sibling;
            }
            if (label === "სართული") {
              const fm = sibling.match(/(\d+)\s*\/\s*(\d+)/);
              if (fm && !floor) { floor = fm[1]; totalFloors = fm[2]; }
            }
          }
        }
      });

      // --- Additional parameters section ---
      let buildingStatus = "";
      let condition = "";
      let projectType = "";
      let bathrooms = "";
      let balconyArea = "";
      let verandaArea = "";
      let loggiaArea = "";
      let cadastralCode = "";

      // Look for label-value pairs in the details section
      // The structure is: div.flex > div(label) + div(value)
      const paramLabels: Record<string, (v: string) => void> = {
        "სტატუსი": (v) => { if (!buildingStatus) buildingStatus = v; },
        "მდგომარეობა": (v) => { if (!condition) condition = v; },
        "პროექტის ტიპი": (v) => { if (!projectType) projectType = v; },
        "სველი წერტილი": (v) => { if (!bathrooms) bathrooms = v; },
        "აივანი": (v) => { if (!balconyArea) balconyArea = v; },
        "ვერანდა": (v) => { if (!verandaArea) verandaArea = v; },
        "ლოჯია": (v) => { if (!loggiaArea) loggiaArea = v; },
        "საკადასტრო კოდი": (v) => { if (!cadastralCode) cadastralCode = v; },
      };

      document.querySelectorAll("div").forEach((container) => {
        const children = Array.from(container.children);
        if (children.length < 2 || children.length > 4) return;
        const childTexts = children.map((c) => c.textContent?.trim() || "");

        for (const [label, setter] of Object.entries(paramLabels)) {
          const labelIdx = childTexts.findIndex((t) => t === label);
          if (labelIdx === -1) continue;
          for (let i = 0; i < childTexts.length; i++) {
            if (i === labelIdx) continue;
            const val = childTexts[i];
            if (val && val !== label && val.length < 100) {
              setter(val);
              rawData[label] = val;
              break;
            }
          }
        }
      });

      // --- Description ("მოკლე აღწერა") ---
      let description = "";
      document.querySelectorAll("div, section").forEach((el) => {
        if (description) return;
        const t = el.textContent?.trim() || "";
        if (t.startsWith("მოკლე აღწერა") && t.length > 15) {
          description = t.replace("მოკლე აღწერა", "").trim();
          description = description.replace(/ნაკლების ნახვა\s*\^?$/i, "").replace(/მეტის ნახვა\s*$/i, "").trim();
        }
      });

      // --- ID ---
      document.querySelectorAll("span").forEach((sp) => {
        const t = sp.textContent?.trim() || "";
        if (t.startsWith("ID:")) rawData["ID"] = t.replace("ID:", "").trim();
      });

      // --- Price per sqm (calculate) ---
      let pricePerSqm = "";
      const numericPrice = parseFloat(price.replace(/[,.\s]/g, ""));
      const numericArea = parseFloat(area.replace(/[^\d.]/g, ""));
      if (numericPrice > 0 && numericArea > 0) {
        pricePerSqm = Math.round(numericPrice / numericArea).toString();
      }

      return {
        title,
        propertyType,
        dealType,
        buildingStatus,
        condition,
        city,
        address,
        street,
        streetNumber,
        cadastralCode,
        price,
        pricePerSqm,
        currency,
        area,
        rooms,
        bedrooms,
        floor,
        totalFloors,
        projectType,
        bathrooms,
        balconyArea,
        verandaArea,
        loggiaArea,
        description,
        images: images.slice(0, 16),
        rawData,
      };
    });

    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to parse listing",
    };
  } finally {
    await context.close();
  }
}

// Open a visible browser, login, navigate to create form, and pre-fill all fields.
// The browser stays open for the user to review and submit manually.
export async function createMyhomePost(
  credentials: MyhomeCredentials,
  listing: MyhomeListing
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "ka-GE",
  });
  const page = await context.newPage();

  try {
    // --- Login via TNET ---
    await page.goto("https://auth.tnet.ge/ka/user/login/?Continue=https://www.myhome.ge/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector('input[name="Email"]', { timeout: 10000 });
    await page.fill('input[name="Email"]', credentials.email);
    await page.fill('input[name="Password"]', credentials.password);
    await page.click('[data-testid="login-form__button-submit"]');
    await page.waitForURL((url) => !url.href.includes("auth.tnet.ge"), {
      timeout: 20000,
    });

    // --- Navigate to create form ---
    await page.goto(
      "https://statements.myhome.ge/ka/statement/create?referrer=myhome",
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );
    await page.waitForSelector("#total_price", { timeout: 20000 });
    await page.waitForTimeout(2000);

    // Use DOM manipulation for fast, non-hanging form fill.
    // Chips = leaf span/div elements with exact text, click the rounded parent.
    // Inputs = found via label > span text, filled with React-compatible setter.
    async function fillForm(data: Record<string, string>) {
      await page.evaluate((d) => {
        // React-compatible input value setter
        const inputSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        )?.set;
        const textareaSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value"
        )?.set;

        function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
          const setter = el.tagName === "TEXTAREA" ? textareaSetter : inputSetter;
          if (setter) {
            setter.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        function clickChip(text: string) {
          if (!text) return;
          let clicked = false;
          document.querySelectorAll("span, div, button, p").forEach((el) => {
            if (clicked) return;
            if (el.children.length > 0) return;
            if (el.textContent?.trim() === text) {
              const chip = (el.closest("div[class*='rounded']") || el) as HTMLElement;
              chip.click();
              clicked = true;
            }
          });
        }

        function fillInputByLabel(labelText: string, value: string) {
          if (!value) return;
          let filled = false;
          document.querySelectorAll("label").forEach((label) => {
            if (filled) return;
            const forAttr = label.getAttribute("for");
            // Check ALL spans inside the label, not just the first
            const spans = label.querySelectorAll("span");
            for (const span of spans) {
              const t = span.textContent?.trim()?.replace(/\s*\*\s*$/, "").trim();
              if (t === labelText) {
                const input = forAttr
                  ? (document.getElementById(forAttr) as HTMLInputElement)
                  : (label.querySelector("input") as HTMLInputElement);
                if (input?.tagName === "INPUT") {
                  setInputValue(input, value);
                  filled = true;
                }
                break;
              }
            }
          });
        }

        // 1. Property type
        clickChip(d.propertyType);

        // 2. Deal type
        clickChip(d.dealType);

        // 3. Building status
        clickChip(d.buildingStatus);

        // 4. Condition
        clickChip(d.condition);

        // 5. Location
        fillInputByLabel("მდებარეობა", d.city);
        fillInputByLabel("ქუჩა", d.street);
        fillInputByLabel("ქუჩის ნომერი", d.streetNumber);
        fillInputByLabel("საკადასტრო კოდი", d.cadastralCode);

        // 6. Price
        if (d.price) {
          const priceInput = document.getElementById("total_price") as HTMLInputElement;
          if (priceInput) setInputValue(priceInput, d.price.replace(/[^\d]/g, ""));
        }

        // 7. Currency toggle
        if (d.currency === "USD") {
          document.querySelectorAll("div").forEach((el) => {
            if (el.textContent?.trim() === "$" && el.children.length === 0) {
              el.click();
            }
          });
        }

        // 8. Area
        fillInputByLabel("ფართი", d.area);

        // 9. Rooms
        if (d.rooms) clickChip(d.rooms === "10" ? "10+" : d.rooms);

        // 10. Floor + total floors
        fillInputByLabel("სართული", d.floor);
        fillInputByLabel("სართულები სულ", d.totalFloors);

        // 11. Bathrooms
        if (d.bathrooms) clickChip(d.bathrooms);

        // 12. Description
        if (d.description) {
          const ta = document.querySelector(
            'textarea[placeholder*="დამატებითი აღწერა"]'
          ) as HTMLTextAreaElement;
          if (ta) setInputValue(ta, d.description);
        }
      }, data);
    }

    // Pass 1: Select property type (triggers form sections to render)
    await fillForm({
      propertyType: listing.propertyType,
      dealType: "", buildingStatus: "", condition: "",
      city: "", street: "", streetNumber: "", cadastralCode: "",
      price: "", currency: "", area: "", rooms: "", floor: "",
      totalFloors: "", bathrooms: "", description: "",
    });
    await page.waitForTimeout(1500);

    // Pass 2: Select deal type (may trigger more sections)
    await fillForm({
      propertyType: "", dealType: listing.dealType,
      buildingStatus: "", condition: "",
      city: "", street: "", streetNumber: "", cadastralCode: "",
      price: "", currency: "", area: "", rooms: "", floor: "",
      totalFloors: "", bathrooms: "", description: "",
    });
    await page.waitForTimeout(1000);

    // Click "ყველა პარამეტრი" to reveal all optional fields
    await page.evaluate(() => {
      document.querySelectorAll("button").forEach((el) => {
        if (el.textContent?.trim() === "ყველა პარამეტრი") el.click();
      });
    });
    await page.waitForTimeout(1000);

    // Pass 3: Fill all remaining fields (all sections should now be visible)
    await fillForm({
      propertyType: "", dealType: "",
      buildingStatus: listing.buildingStatus,
      condition: listing.condition,
      city: listing.city,
      street: listing.street,
      streetNumber: listing.streetNumber,
      cadastralCode: listing.cadastralCode,
      price: listing.price,
      currency: listing.currency,
      area: listing.area,
      rooms: listing.rooms,
      floor: listing.floor,
      totalFloors: listing.totalFloors,
      bathrooms: listing.bathrooms,
      description: listing.description,
    });

    // City dropdown: type triggers autocomplete, select the matching option
    if (listing.city) {
      try {
        await page.waitForTimeout(800);
        const option = page.locator("[class*='option'], li")
          .filter({ hasText: listing.city }).first();
        if (await option.isVisible({ timeout: 2000 })) {
          await option.click();
          await page.waitForTimeout(500);
        }
      } catch { /* city dropdown not found */ }
    }

    // Project type: custom dropdown, click to open then select option
    if (listing.projectType) {
      try {
        const selectTrigger = page.locator(".luk-custom-select")
          .filter({ hasText: "აირჩიეთ პროექტის ტიპი" }).first();
        await selectTrigger.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        const option = page.locator("[class*='option'], li")
          .filter({ hasText: listing.projectType }).first();
        if (await option.isVisible({ timeout: 2000 })) {
          await option.click();
        }
      } catch { /* project type dropdown failed */ }
    }

    // Browser stays open for user review
    return {
      success: true,
      postUrl: page.url(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create post",
    };
  }
  // No finally block -- browser stays open intentionally
}
