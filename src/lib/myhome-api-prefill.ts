/**
 * myhome.ge listing prefill via tnet HTTP APIs (no Playwright).
 *
 * Flow (from capture spike):
 *   1. POST accounts.tnet.ge/api/ka/user/auth → JWT tokens
 *   2. POST static-statements.tnet.ge/v1/files/upload-image (per photo)
 *   3. POST api-statements.tnet.ge/v1/statements/create (multipart)
 *   4. POST /v2/payments/init-statement-services
 *   5. POST /v2/payments/pay (balance)
 *
 * Enable with MYHOME_API_PREFILL=true (falls back to browser prefill on failure
 * when MYHOME_API_PREFILL_FALLBACK=true, the default).
 */
import { readFile } from "fs/promises";
import path from "path";
import type { MyhomeCredentials, MyhomeListing } from "@/lib/myhome-parser";
import {
  normalizeListingForMyhomePrefill,
} from "@/lib/cross-platform-prefill";
import { resolveMyhomeLocationIds } from "@/lib/myhome-api-location";
import {
  reverseBathroomTypeId,
  reverseBedroomTypeId,
  reverseMaps,
  reverseRoomTypeId,
} from "@/lib/myhome-api-reverse";
import {
  appendExtendedCreateFields,
  parseStatementMetadata,
  resolveListingParameterIds,
  type StatementMetadata,
} from "@/lib/myhome-api-form-fields";
import {
  MAX_LISTING_IMAGES,
  resolveImagesForPlaywright,
} from "@/lib/listing-images";
import {
  noopPrefillReporter,
  type PrefillReporter,
} from "@/lib/prefill-progress";
import {
  DEFAULT_PROJECT_TYPE,
  mapLandPlotStatusForMyhome,
  resolveProjectTypeCanonical,
} from "@/lib/ssge-mappings";

const AUTH_URL = "https://accounts.tnet.ge/api/ka/user/auth";
const API_BASE = "https://api-statements.tnet.ge";
const STATIC_BASE = "https://static-statements.tnet.ge";
const FETCH_TIMEOUT_MS = parseInt(process.env.PARSE_GOTO_TIMEOUT_MS || "20000", 10);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Optional operator override; normally the fee is resolved from the live catalog. */
function serviceTypeIdOverride(): number | null {
  const raw = process.env.MYHOME_SERVICE_TYPE_ID;
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function defaultServiceDays(): number {
  return parseInt(process.env.MYHOME_SERVICE_DAYS || "30", 10);
}

/** statements.tnet.ge website ids (WEBSITES = { LIVO: 1, MYHOME: 2 }). */
const MYHOME_WEBSITE_ID = 2;

export function isMyhomeApiPrefillEnabled(): boolean {
  return process.env.MYHOME_API_PREFILL === "true";
}

export function shouldFallbackToBrowserPrefill(): boolean {
  return process.env.MYHOME_API_PREFILL_FALLBACK !== "false";
}

interface MyhomeApiSession {
  accessToken: string;
  refreshToken: string;
}

interface UploadedImage {
  id: number;
  url: string;
}

function apiHeaders(session: MyhomeApiSession, extra?: Record<string, string>) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ka-GE",
    "X-Website-Key": "myhome",
    "x-referrer-key": "myhome",
    "global-authorization": session.accessToken,
    Cookie: `AccessToken=${session.accessToken}; RefreshToken=${session.refreshToken}`,
    Origin: "https://statements.myhome.ge",
    Referer: "https://statements.myhome.ge/",
    "User-Agent": UA,
    ...extra,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseTokensFromJson(body: unknown): Partial<MyhomeApiSession> | null {
  const root = body as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const accessToken = String(
    data.AccessToken ?? data.access_token ?? data.accessToken ?? ""
  );
  const refreshToken = String(
    data.RefreshToken ?? data.refresh_token ?? data.refreshToken ?? ""
  );
  if (!accessToken) return null;
  return { accessToken, refreshToken: refreshToken || accessToken };
}

function parseTokensFromRedirectUrl(url: string): Partial<MyhomeApiSession> | null {
  try {
    const u = new URL(url);
    const accessToken = u.searchParams.get("AccessToken") || "";
    const refreshToken = u.searchParams.get("RefreshToken") || "";
    if (!accessToken) return null;
    return { accessToken, refreshToken: refreshToken || accessToken };
  } catch {
    return null;
  }
}

function parseSetCookieTokens(setCookies: string[]): Partial<MyhomeApiSession> | null {
  let accessToken = "";
  let refreshToken = "";
  for (const line of setCookies) {
    const m = line.match(/^AccessToken=([^;]+)/i);
    if (m) accessToken = m[1];
    const r = line.match(/^RefreshToken=([^;]+)/i);
    if (r) refreshToken = r[1];
  }
  if (!accessToken) return null;
  return { accessToken, refreshToken: refreshToken || accessToken };
}

export async function loginMyhomeApi(
  credentials: MyhomeCredentials
): Promise<{ success: boolean; session?: MyhomeApiSession; error?: string }> {
  try {
    const res = await fetchWithTimeout(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://auth.tnet.ge",
        Referer: "https://auth.tnet.ge/",
        "User-Agent": UA,
      },
      body: JSON.stringify({
        Email: credentials.email,
        Password: credentials.password,
        token: "",
        Continue: "https://www.myhome.ge/",
      }),
    });

    if (!res.ok) {
      return { success: false, error: `Login failed (HTTP ${res.status})` };
    }

    let session: Partial<MyhomeApiSession> | null = null;

    const text = await res.text();
    if (text) {
      try {
        session = parseTokensFromJson(JSON.parse(text));
      } catch {
        /* not JSON */
      }
    }

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [];
    if (!session && setCookies.length) {
      session = parseSetCookieTokens(setCookies);
    }

    if (!session) {
      const loc = res.headers.get("location");
      if (loc) session = parseTokensFromRedirectUrl(loc);
    }

    if (!session?.accessToken) {
      return { success: false, error: "Login succeeded but no auth tokens in response" };
    }

    return {
      success: true,
      session: {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken || session.accessToken,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Login request failed",
    };
  }
}

async function fetchStatementMetadata(
  session: MyhomeApiSession
): Promise<StatementMetadata> {
  const res = await fetchWithTimeout(
    `${API_BASE}/v1/statements/statement-parameters?lang=ka&exclude_cities=1`,
    { headers: apiHeaders(session) }
  );
  if (!res.ok) return { statement_parameters: {} };
  const json = await res.json();
  return parseStatementMetadata(json);
}

function parseMyhomeUserProfile(body: unknown): {
  phone?: string;
  name?: string;
} {
  const root = body as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const phone = String(
    data.phone ??
      data.phone_number ??
      data.user_phone_number ??
      data.mobile ??
      data.mobile_number ??
      ""
  ).trim();
  const name = String(
    data.name ?? data.display_name ?? data.user_name ?? data.full_name ?? ""
  ).trim();
  return {
    phone: phone || undefined,
    name: name || undefined,
  };
}

async function fetchUserProfile(session: MyhomeApiSession): Promise<{
  phone?: string;
  name?: string;
}> {
  const res = await fetchWithTimeout(`${API_BASE}/v1/users/me`, {
    headers: apiHeaders(session),
  });
  if (!res.ok) return {};
  const json = await res.json();
  return parseMyhomeUserProfile(json);
}

function digitsOnlyPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return d.slice(-9);
}

/** Contact fields for statement create — account only, never parsed seller data. */
export function resolveMyhomePublishContact(profile: {
  phone?: string;
  name?: string;
}): { phone: string; ownerName: string; error?: string } {
  const phone = digitsOnlyPhone(profile.phone || "");
  if (!phone || phone.length !== 9 || !phone.startsWith("5")) {
    return {
      phone: "",
      ownerName: "",
      error:
        "Logged-in myhome account has no valid mobile phone. Set it on myhome.ge before publishing.",
    };
  }
  return { phone, ownerName: profile.name?.trim() || "" };
}

const IMAGE_UPLOAD_ATTEMPTS = parseInt(
  process.env.MYHOME_IMAGE_UPLOAD_ATTEMPTS || "3",
  10
);

async function uploadImageOnce(
  filePath: string,
  session: MyhomeApiSession
): Promise<UploadedImage | null> {
  const buf = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append("image", new Blob([buf], { type: mime }), filename);
  form.append("type", "1");

  const res = await fetchWithTimeout(`${STATIC_BASE}/v1/files/upload-image`, {
    method: "POST",
    headers: apiHeaders(session),
    body: form,
  });

  if (!res.ok) {
    console.warn(`[myhome-api] image upload failed: HTTP ${res.status}`);
    return null;
  }

  const json = (await res.json()) as {
    result?: boolean;
    data?: { id?: number; url?: string };
  };
  if (!json.result || !json.data?.id || !json.data?.url) return null;
  return { id: json.data.id, url: json.data.url };
}

/**
 * The upload endpoint returns sporadic 500s; a dropped photo is permanent for the
 * listing, so retry before giving up on one.
 */
async function uploadImage(
  filePath: string,
  session: MyhomeApiSession
): Promise<UploadedImage | null> {
  for (let attempt = 1; attempt <= IMAGE_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const uploaded = await uploadImageOnce(filePath, session);
      if (uploaded) return uploaded;
    } catch (err) {
      console.warn(
        `[myhome-api] image upload attempt ${attempt} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (attempt < IMAGE_UPLOAD_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  console.warn(
    `[myhome-api] giving up on image after ${IMAGE_UPLOAD_ATTEMPTS} attempts: ${path.basename(filePath)}`
  );
  return null;
}

function appendIf(form: FormData, key: string, value: string | number | undefined) {
  if (value === undefined || value === null) return;
  const s = String(value).trim();
  if (!s) return;
  form.append(key, s);
}

function normalizeStatusToken(value: string | undefined): string {
  const s = (value || "").trim();
  if (!s || s === "-" || s === "—") return "";
  return s;
}

function resolveStatusIdForCreate(
  listing: MyhomeListing,
  raw: Record<string, string>
): number | undefined {
  const landRaw = normalizeStatusToken(raw["მიწის ნაკვეთი"]);
  const landMapped = landRaw ? mapLandPlotStatusForMyhome(landRaw) : "";

  const candidates = [
    normalizeStatusToken(listing.buildingStatus),
    normalizeStatusToken(raw["სტატუსი"]),
    landMapped,
    landRaw,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const id = reverseMaps.status(candidate);
    if (id) return id;
  }
  return undefined;
}

function resolveProjectTypeIdForCreate(
  listing: MyhomeListing,
  raw: Record<string, string>
): number | undefined {
  const canonical = resolveProjectTypeCanonical(
    listing.projectType || "",
    raw
  );
  const normalized = canonical || DEFAULT_PROJECT_TYPE;
  return (
    reverseMaps.projectType(normalized) ||
    reverseMaps.projectType(DEFAULT_PROJECT_TYPE)
  );
}

function buildCreateForm(
  listing: MyhomeListing,
  location: NonNullable<Awaited<ReturnType<typeof resolveMyhomeLocationIds>>>,
  images: UploadedImage[],
  parameterIds: number[],
  profile: { phone?: string; name?: string },
  metadata: StatementMetadata
): FormData {
  const form = new FormData();
  const raw = listing.rawData ?? {};
  const isLand = /მიწის\s*ნაკვეთ/i.test(listing.propertyType || "");

  const dealTypeId = reverseMaps.dealType(listing.dealType);
  appendIf(form, "real_estate_type_id", reverseMaps.propertyType(listing.propertyType));
  appendIf(form, "deal_type_id", dealTypeId);
  appendIf(form, "city_id", location.city_id);
  appendIf(form, "street_id", location.street_id);
  appendIf(form, "location_id", location.location_id);
  appendIf(form, "district_id", location.district_id);
  appendIf(form, "urban_id", location.urban_id);
  form.append("rs_code", listing.cadastralCode?.trim() || "");
  form.append("appear_rs_code", listing.cadastralCode?.trim() ? "1" : "0");
  appendIf(form, "longitude", location.longitude);
  appendIf(form, "latitude", location.latitude);
  form.append("duration_id", "1");

  parameterIds.forEach((id, i) => {
    form.append(`parameters[${i}]`, String(id));
  });

  const statusId = resolveStatusIdForCreate(listing, raw);
  if (statusId) appendIf(form, "status_id", statusId);

  const projectId = resolveProjectTypeIdForCreate(listing, raw);
  if (projectId) appendIf(form, "project_type_id", projectId);

  if (!isLand) {
    appendIf(form, "room_type_id", reverseRoomTypeId(listing.rooms));
    appendIf(
      form, "bedroom_type_id",
      reverseBedroomTypeId(
        listing.bedrooms || raw["საძინებელი"] || raw["საძინებლები"] || ""
      )
    );
    appendIf(
      form, "bathroom_type_id",
      reverseBathroomTypeId(
        listing.bathrooms ||
          raw["სვ.წერტილი"] ||
          raw["სველი წერტილი"] ||
          ""
      )
    );
    appendIf(form, "floor", listing.floor);
    appendIf(form, "total_floors", listing.totalFloors);
  }

  const conditionId = reverseMaps.condition(listing.condition || raw["მდგომარეობა"] || "");
  if (conditionId) appendIf(form, "condition_id", conditionId);

  const area =
    listing.area?.replace(/[^\d.]/g, "") ||
    raw["ფართი"]?.replace(/[^\d.]/g, "") ||
    "";
  appendIf(form, "area", area);
  form.append("area_type_id", "1");

  const price = listing.price?.replace(/[^\d.]/g, "") || "";
  appendIf(form, "total_price", price);
  form.append("price_type_id", "3");

  let sqm = listing.pricePerSqm?.replace(/[^\d.]/g, "") || "";
  if (!sqm && price && area) {
    const p = parseFloat(price);
    const a = parseFloat(area);
    if (p > 0 && a > 0) sqm = String(Math.round((p / a) * 100) / 100);
  }
  appendIf(form, "square_price", sqm);

  const currencyId = reverseMaps.currency(listing.currency || "USD") ?? 2;
  form.append("currency_id", String(currencyId));
  // myhome rejects `can_exchanged` unless deal_type_id === 1 (sale). Exchange is
  // only meaningful when selling, so omit it for rent/lease/daily deal types.
  if (dealTypeId === 1) {
    form.append("can_exchanged", "0");
  }

  const contact = resolveMyhomePublishContact(profile);
  if (contact.error) {
    throw new Error(contact.error);
  }
  form.append("phone_number", contact.phone);

  const streetDisplay = location.streetDisplay;
  const streetNumber = listing.streetNumber || raw["ქუჩის ნომერი"] || "";
  const ownerName = contact.ownerName;

  const comment = listing.description?.trim() || "";
  for (const lang of ["ka", "en", "ru"] as const) {
    form.append(`${lang}[comment]`, comment);
    form.append(`${lang}[address]`, streetDisplay);
    if (ownerName) form.append(`${lang}[owner_name]`, ownerName);
    if (streetNumber) form.append(`${lang}[street_number]`, streetNumber);
  }

  images.forEach((img, i) => {
    form.append(`images[${i}][image_id]`, String(img.id));
    form.append(`images[${i}][url]`, img.url);
  });

  form.append("websites[0]", "1");
  form.append("websites[1]", "2");

  appendExtendedCreateFields(form, listing, metadata);

  return form;
}

async function createStatement(
  session: MyhomeApiSession,
  form: FormData
): Promise<{ uuid: string } | { error: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/v1/statements/create`, {
    method: "POST",
    headers: apiHeaders(session),
    body: form,
  });

  const json = (await res.json().catch(() => ({}))) as {
    result?: boolean;
    data?: { uuid?: string };
    errors?: unknown;
  };

  if (!res.ok || !json.result || !json.data?.uuid) {
    const detail = JSON.stringify(json.errors ?? json).slice(0, 400);
    return { error: `Create statement failed (HTTP ${res.status}): ${detail}` };
  }

  return { uuid: json.data.uuid };
}

export interface MyhomeServiceType {
  id: number;
  day: number;
}

interface CatalogServiceType {
  id?: number;
  day?: number;
  value?: number;
  selects?: Array<{ value?: number }>;
}

interface CatalogService {
  id?: number;
  icon?: string;
  website_id?: number;
  /** The site preselects "marked" services and disables deselecting them. */
  marked?: boolean;
  types?: CatalogServiceType[];
}

function firstServiceType(service: CatalogService): MyhomeServiceType | null {
  const type = service.types?.[0];
  if (!type?.id) return null;
  const day =
    type.day ?? type.selects?.[0]?.value ?? type.value ?? defaultServiceDays();
  return { id: type.id, day };
}

/**
 * The services the site would preselect for this account at checkout.
 *
 * A hardcoded service type id does not survive catalog changes — it comes back
 * as `422 service_types is required` and every prefill then falls through to the
 * browser. An empty list is a valid answer: nothing is owed, so the statement is
 * already published by `statements/create` alone (the site skips payment init
 * entirely in that case).
 */
export async function fetchRequiredServiceTypes(
  session: MyhomeApiSession
): Promise<{ types: MyhomeServiceType[]; error?: string }> {
  const override = serviceTypeIdOverride();
  if (override) {
    return { types: [{ id: override, day: defaultServiceDays() }] };
  }

  const res = await fetchWithTimeout(
    `${API_BASE}/v2/services?websites=${MYHOME_WEBSITE_ID}`,
    { method: "GET", headers: apiHeaders(session) }
  );
  if (!res.ok) {
    return { types: [], error: `services catalog failed (HTTP ${res.status})` };
  }

  const body = (await res.json().catch(() => null)) as
    | CatalogService[]
    | { data?: CatalogService[] }
    | null;
  const catalog = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(catalog)) {
    return { types: [], error: "services catalog returned no list" };
  }

  const required = catalog.filter(
    (service) =>
      service.marked === true &&
      (service.website_id === undefined ||
        service.website_id === MYHOME_WEBSITE_ID)
  );

  const types: MyhomeServiceType[] = [];
  for (const service of required) {
    const type = firstServiceType(service);
    if (type) types.push(type);
  }

  // Logged in full: if a fee turns out to be due that we did not detect, this
  // line is the whole catalog needed to fix it without another spike.
  console.log(
    `[myhome-api] services catalog (${catalog.length}): ` +
      catalog
        .map(
          (s) =>
            `${s.icon || s.id}#${s.types?.[0]?.id ?? "?"}${s.marked ? "*" : ""}`
        )
        .join(" ") +
      ` → ${types.length} required`
  );

  return { types };
}

async function payForStatement(
  session: MyhomeApiSession,
  statementUuid: string,
  serviceTypes: MyhomeServiceType[]
): Promise<{ success: boolean; error?: string }> {
  const initRes = await fetchWithTimeout(
    `${API_BASE}/v2/payments/init-statement-services`,
    {
      method: "POST",
      headers: apiHeaders(session, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        statement_uuids: [statementUuid],
        service_types: serviceTypes,
      }),
    }
  );

  const initRaw = await initRes.text();
  let initJson: {
    result?: boolean;
    data?: { payment_uuid?: string };
    errors?: unknown;
  } = {};
  try {
    initJson = JSON.parse(initRaw);
  } catch {
    /* non-JSON */
  }
  const paymentUuid = initJson.data?.payment_uuid;
  if (!initRes.ok || !initJson.result || !paymentUuid) {
    const detail = JSON.stringify(initJson.errors ?? initRaw).slice(0, 400);
    return {
      success: false,
      error: `Payment init failed (HTTP ${initRes.status}): ${detail}`,
    };
  }

  const payRes = await fetchWithTimeout(`${API_BASE}/v2/payments/pay`, {
    method: "POST",
    headers: apiHeaders(session, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      payment_uuid: paymentUuid,
      pay_method: "balance",
      redirect_url:
        "https://statements.myhome.ge/ka/status/pending?referrer=myhome",
    }),
  });

  const payJson = (await payRes.json().catch(() => ({}))) as {
    result?: boolean;
    data?: { status?: string };
  };

  if (!payRes.ok || !payJson.result || payJson.data?.status !== "success") {
    return {
      success: false,
      error: `Balance payment failed (HTTP ${payRes.status}, status=${payJson.data?.status ?? "?"})`,
    };
  }

  return { success: true };
}

export async function fetchMyhomeAccountContact(
  credentials: MyhomeCredentials
): Promise<{ phone?: string; name?: string; error?: string }> {
  const auth = await loginMyhomeApi(credentials);
  if (!auth.success || !auth.session) {
    return { error: auth.error || "API login failed" };
  }
  const profile = await fetchUserProfile(auth.session);
  const contact = resolveMyhomePublishContact(profile);
  if (contact.error) return { error: contact.error };
  return { phone: contact.phone, name: contact.ownerName };
}

export async function createMyhomePostViaApi(
  credentials: MyhomeCredentials,
  listing: MyhomeListing,
  options: {
    listingId: string;
    userId: string;
    sourceUrl?: string | null;
    reporter?: PrefillReporter;
  }
): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
  /** True once the statement exists on myhome — callers must not retry via browser. */
  listingCreated?: boolean;
}> {
  const reporter = options.reporter ?? noopPrefillReporter;
  listing = normalizeListingForMyhomePrefill(listing, {
    sourceUrl: options.sourceUrl,
  });

  const autoPublish = process.env.MYHOME_AUTO_PUBLISH === "true";

  try {
    reporter.stepDone("browser", "API mode (no browser)");
    reporter.step("login");

    const auth = await loginMyhomeApi(credentials);
    if (!auth.success || !auth.session) {
      reporter.stepDone("login", "Failed");
      return { success: false, error: auth.error || "API login failed" };
    }
    const session = auth.session;
    reporter.stepDone("login");

    reporter.stepDone("form", "Skipped (API)");

    reporter.step("fields");
    const location = await resolveMyhomeLocationIds(listing);
    if (!location) {
      reporter.stepDone("fields", "Location unresolved");
      return { success: false, error: "Could not resolve street/location IDs for API create" };
    }

    if (!reverseMaps.propertyType(listing.propertyType)) {
      return { success: false, error: `Unknown property type: ${listing.propertyType}` };
    }
    if (!reverseMaps.dealType(listing.dealType)) {
      return { success: false, error: `Unknown deal type: ${listing.dealType}` };
    }

    const [metadata, profile] = await Promise.all([
      fetchStatementMetadata(session),
      fetchUserProfile(session),
    ]);
    const profileContact = resolveMyhomePublishContact(profile);
    if (profileContact.phone) {
      console.log(
        `[myhome-api] account contact: phone=${profileContact.phone.slice(0, 3)}…` +
          ` name="${profileContact.ownerName || "(empty)"}"`
      );
    } else if (profileContact.error) {
      console.warn(`[myhome-api] ${profileContact.error}`);
    }
    const dealTypeId = reverseMaps.dealType(listing.dealType) ?? 1;
    const parameterIds = resolveListingParameterIds(listing, metadata, dealTypeId);
    reporter.stepDone("fields", location.streetDisplay);

    reporter.step("amenities", `${parameterIds.length} parameter(s)`);
    reporter.stepDone("amenities");

    let uploaded: UploadedImage[] = [];
    if (listing.images.length > 0) {
      reporter.step("images", `${listing.images.length} photo(s)`);
      const { paths, cleanup } = await resolveImagesForPlaywright(
        listing.images,
        options.listingId,
        options.userId
      );
      try {
        for (const p of paths.slice(0, MAX_LISTING_IMAGES)) {
          const img = await uploadImage(p, session);
          if (img) uploaded.push(img);
        }
      } finally {
        await cleanup();
      }
      reporter.stepDone("images", `${uploaded.length} uploaded`);
    } else {
      reporter.stepDone("images", "No photos");
    }

    if (!autoPublish) {
      reporter.stepDone("publish", "Skipped (MYHOME_AUTO_PUBLISH=false)");
      reporter.stepDone("checkout", "Skipped");
      reporter.success("API prefill validated (auto-publish off)");
      return {
        success: true,
        postUrl: "https://statements.myhome.ge/ka/statement/create?referrer=myhome",
      };
    }

    reporter.step("publish");
    const contact = resolveMyhomePublishContact(profile);
    if (contact.error) {
      reporter.stepDone("publish", "No account phone");
      return { success: false, error: contact.error };
    }

    const parsedSellerPhone = digitsOnlyPhone(
      listing.rawData?.["ნომერი"] || listing.mobileNumber || ""
    );
    if (parsedSellerPhone && parsedSellerPhone !== contact.phone) {
      console.log(
        `[myhome-api] using account phone ${contact.phone.slice(0, 3)}… ` +
          `(ignoring parsed seller phone ${parsedSellerPhone.slice(0, 3)}…)`
      );
    }

    const form = buildCreateForm(
      listing,
      location,
      uploaded,
      parameterIds,
      profile,
      metadata
    );
    const created = await createStatement(session, form);
    if ("error" in created) {
      reporter.stepDone("publish", "Failed");
      return { success: false, error: created.error };
    }
    reporter.stepDone("publish", `uuid ${created.uuid.slice(0, 8)}…`);

    // From here on the statement exists on myhome.ge. Any later failure must not
    // hand over to the browser flow — that would publish the same listing twice.
    const statementsUrl =
      "https://statements.myhome.ge/ka/user-profile/my-statements?referrer=myhome";

    reporter.step("checkout");
    const required = await fetchRequiredServiceTypes(session);
    if (required.error) {
      reporter.stepWarn(
        "checkout",
        `Could not read paid services (${required.error}) — publish fee not paid`
      );
      return { success: true, postUrl: statementsUrl, listingCreated: true };
    }

    if (required.types.length === 0) {
      reporter.stepDone("checkout", "No publish fee due");
    } else {
      const paid = await payForStatement(session, created.uuid, required.types);
      if (!paid.success) {
        reporter.stepWarn("checkout", paid.error || "Payment failed");
        return {
          success: false,
          error: paid.error || "Payment failed",
          postUrl: statementsUrl,
          listingCreated: true,
        };
      }
      reporter.stepDone("checkout", "Balance paid");
    }

    const postUrl =
      "https://statements.myhome.ge/ka/status/success?referrer=myhome&scenario=payment";
    reporter.success(`Listing published via API (${created.uuid})`);
    return { success: true, postUrl, listingCreated: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "API prefill failed";
    reporter.log("error", msg);
    return { success: false, error: msg };
  }
}
