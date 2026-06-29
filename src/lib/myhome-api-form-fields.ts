/**
 * Map parsed listing fields → myhome create-statement multipart form fields.
 */
import type { MyhomeListing } from "@/lib/myhome-parser";
import {
  FURNITURE_LABELS,
  LABEL_CANONICAL,
  PREFERENCE_PARAM_LABELS,
  PREFILL_NUMERIC_LABELS,
  RAW_DATA_HANDLED_LABELS,
} from "@/lib/additional-params";
import { reverseMaps } from "@/lib/myhome-api-reverse";

export interface StatementParameter {
  id: number;
  display_name?: string;
  deal_types?: number[];
}

export interface StatementMetadata {
  statement_parameters: Record<string, StatementParameter[]>;
  build_years?: { id: number; display_name: string }[];
  living_room_types?: { id: number; display_name: string }[];
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function normLower(s: string): string {
  return norm(s).toLowerCase();
}

function isYesValue(v: string | undefined): boolean {
  const s = (v || "").trim();
  return s === "კი" || s === "დიახ" || s.toLowerCase() === "yes";
}

function ensureFurnitureRawData(rawData: Record<string, string>): void {
  if (rawData["ავეჯი"] === "არა") return;
  const anyItem = FURNITURE_LABELS.some(
    (item) => item !== "ავეჯი" && rawData[item] === "კი"
  );
  if (anyItem || rawData["ავეჯი"] === "კი") {
    rawData["ავეჯი"] = "კი";
  }
}

function shouldSkipYesChip(label: string): boolean {
  if (RAW_DATA_HANDLED_LABELS.has(label)) return true;
  if (PREFILL_NUMERIC_LABELS.has(label)) return true;
  if ((PREFERENCE_PARAM_LABELS as readonly string[]).includes(label)) return true;
  return false;
}

function listingHasFurniture(rawData: Record<string, string>): boolean {
  if (rawData["ავეჯი"] === "კი") return true;
  if (rawData["ავეჯი"] === "არა") return false;
  return FURNITURE_LABELS.some((item) => item !== "ავეჯი" && rawData[item] === "კი");
}

function parameterLabelsForRawKey(key: string): string[] {
  const labels = new Set<string>();
  labels.add(key);
  labels.add(LABEL_CANONICAL[key] || key);
  if (key === "ქურა") labels.add("ქურა (გაზის/ელექტრო)");
  return [...labels];
}

function buildParameterNameIndex(
  parameters: StatementParameter[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of parameters) {
    const name = p.display_name?.trim();
    if (!name || !p.id) continue;
    map.set(normLower(name), p.id);
  }
  return map;
}

function lookupParameterId(
  index: Map<string, number>,
  label: string
): number | undefined {
  const want = normLower(label);
  if (index.has(want)) return index.get(want);
  for (const [name, id] of index) {
    if (name.includes(want) || want.includes(name)) return id;
  }
  return undefined;
}

export function parametersForPropertyType(
  metadata: StatementMetadata,
  realEstateTypeId: number
): StatementParameter[] {
  const key = String(realEstateTypeId);
  const bucket = metadata.statement_parameters?.[key];
  return Array.isArray(bucket) ? bucket : [];
}

export function resolveListingParameterIds(
  listing: MyhomeListing,
  metadata: StatementMetadata,
  dealTypeId: number
): number[] {
  const raw = { ...(listing.rawData ?? {}) };
  ensureFurnitureRawData(raw);

  const typeId = reverseMaps.propertyType(listing.propertyType || "");
  if (!typeId) return [];

  const available = parametersForPropertyType(metadata, typeId).filter(
    (p) =>
      !p.deal_types?.length ||
      p.deal_types.includes(dealTypeId)
  );
  const index = buildParameterNameIndex(available);
  const ids = new Set<number>();

  for (const [key, value] of Object.entries(raw)) {
    if (!isYesValue(value)) continue;
    if (shouldSkipYesChip(key)) continue;

    for (const label of parameterLabelsForRawKey(key)) {
      const id = lookupParameterId(index, label);
      if (id) ids.add(id);
    }
  }

  if (listingHasFurniture(raw)) {
    const furnitureId = lookupParameterId(index, "ავეჯი");
    if (furnitureId) ids.add(furnitureId);
  }

  return [...ids];
}

function parseTypeAndArea(value: string): { type: string; area: string } {
  const v = value.trim();
  if (!v) return { type: "", area: "" };
  const slash = v.match(/^(.+?)\/(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)?\s*$/iu);
  if (slash) {
    return {
      type: slash[1].trim(),
      area: slash[2].replace(",", "."),
    };
  }
  const spaced = v.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:მ²|m²)\s*$/iu);
  if (spaced) {
    return {
      type: spaced[1].trim(),
      area: spaced[2].replace(",", "."),
    };
  }
  return { type: v, area: "" };
}

function firstRawValue(
  raw: Record<string, string>,
  keys: string[]
): string {
  for (const k of keys) {
    const v = raw[k]?.trim();
    if (v) return v;
  }
  return "";
}

function reverseIdByDisplayName(
  items: { id: number; display_name: string }[] | undefined,
  label: string
): number | undefined {
  if (!items?.length || !label.trim()) return undefined;
  const want = normLower(label);
  for (const item of items) {
    if (normLower(item.display_name) === want) return item.id;
  }
  for (const item of items) {
    const n = normLower(item.display_name);
    if (n.includes(want) || want.includes(n)) return item.id;
  }
  return undefined;
}

function normalizeArea(value: string): string {
  const m = value.match(/(\d+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : value.replace(/[^\d.,]/g, "");
}

function normalizeCeilingHeight(value: string): string {
  const m = value.match(/(\d+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : value.replace(/[^\d.,]/g, "");
}

function balconyArea(raw: Record<string, string>, listing: MyhomeListing): string {
  const direct = raw["აივნის ფართი"]?.trim() || listing.balconyArea?.trim();
  if (direct) return normalizeArea(direct);
  const combined = raw["აივანი"]?.trim();
  if (combined) return parseTypeAndArea(combined).area;
  return "";
}

function livingRoomFields(
  raw: Record<string, string>,
  metadata: StatementMetadata
): { typeId?: number; area?: string } {
  const combined =
    firstRawValue(raw, ["მისაღები", "მისაღების ტიპი"]) ||
    firstRawValue(raw, ["მისაღების ფართი"]);
  const areaDirect = raw["მისაღების ფართი"]?.trim();
  const { type, area } = parseTypeAndArea(combined);
  const typeLabel = type || combined;
  const typeId = reverseIdByDisplayName(metadata.living_room_types, typeLabel);
  const resolvedArea = areaDirect
    ? normalizeArea(areaDirect)
    : area
      ? normalizeArea(area)
      : "";
  return { typeId, area: resolvedArea };
}

export function appendExtendedCreateFields(
  form: FormData,
  listing: MyhomeListing,
  metadata: StatementMetadata
): void {
  const raw = listing.rawData ?? {};
  const isLand = /მიწის\s*ნაკვეთ/i.test(listing.propertyType || "");

  const append = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === null) return;
    const s = String(value).trim();
    if (!s) return;
    form.append(key, s);
  };

  const heating = firstRawValue(raw, ["გათბობა", "გათბობის ტიპი"]);
  const hotWater = firstRawValue(raw, ["ცხელი წყალი", "ცხელი წყლის ტიპი"]);
  const parking = firstRawValue(raw, ["პარკირება"]);
  const material = firstRawValue(raw, ["სამშენებლო მასალა", "მასალა"]);
  const doorWindow = firstRawValue(raw, ["კარ-ფანჯარა", "კარი/ფანჯარა"]);

  append("heating_type_id", reverseMaps.heating(heating));
  append("hot_water_type_id", reverseMaps.hotWater(hotWater));
  append("parking_type_id", reverseMaps.parking(parking));
  append("material_type_id", reverseMaps.material(material));
  append("door_window_type_id", reverseMaps.doorWindow(doorWindow));

  const buildYear = raw["აშენების წელი"]?.trim();
  if (buildYear) {
    append(
      "build_year_id",
      reverseIdByDisplayName(metadata.build_years, buildYear) ??
        reverseIdByDisplayName(metadata.build_years, buildYear.replace(/\s+/g, ""))
    );
  }

  if (!isLand) {
    const { typeId, area } = livingRoomFields(raw, metadata);
    append("living_room_type_id", typeId);
    append("living_room_area", area);

    const ceiling = raw["ჭერის სიმაღლე"]?.trim();
    if (ceiling) append("ceiling_height", normalizeCeilingHeight(ceiling));

    const yard = raw["ეზოს ფართი"]?.trim();
    if (yard) append("yard_area", normalizeArea(yard));

    const kitchen = raw["სამზარეულოს ფართი"]?.trim();
    if (kitchen) append("kitchen_area", normalizeArea(kitchen));

    const balcony = balconyArea(raw, listing);
    if (balcony) append("balcony_area", balcony);

    const loggia = raw["ლოჯიის ფართი"]?.trim() || listing.loggiaArea?.trim();
    if (loggia) append("loggia_area", normalizeArea(loggia));

    const porch = raw["ვერანდის ფართი"]?.trim() || listing.verandaArea?.trim();
    if (porch) append("porch_area", normalizeArea(porch));

    const storeroomArea = raw["სათავსოს ფართი"]?.trim();
    if (storeroomArea) append("storeroom_area", normalizeArea(storeroomArea));

    const storeroomCombined = firstRawValue(raw, ["სათავსო", "სათავსოს ტიპი"]);
    if (storeroomCombined && !isYesValue(storeroomCombined)) {
      const { type, area } = parseTypeAndArea(storeroomCombined);
      const storeroomType = reverseMaps.storeroom(type || storeroomCombined);
      if (storeroomType) append("storeroom_type_id", storeroomType);
      if (area && !storeroomArea) append("storeroom_area", area);
    }
  }
}

export function parseStatementMetadata(body: unknown): StatementMetadata {
  const root = body as {
    data?: StatementMetadata;
  };
  const data = root.data ?? (body as StatementMetadata);
  return {
    statement_parameters: data.statement_parameters ?? {},
    build_years: data.build_years,
    living_room_types: data.living_room_types,
  };
}
