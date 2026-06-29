/**
 * Reverse lookups: Georgian display labels → myhome API numeric ids.
 * Mirrors src/lib/myhome-api-constants.ts (parser read path).
 */
import {
  MYHOME_BATHROOM_TYPE,
  MYHOME_BEDROOM_TYPE,
  MYHOME_CONDITION,
  MYHOME_CURRENCY,
  MYHOME_DEAL_TYPE,
  MYHOME_DOOR_WINDOW_TYPE,
  MYHOME_HEATING_TYPE,
  MYHOME_HOT_WATER_TYPE,
  MYHOME_MATERIAL_TYPE,
  MYHOME_PARKING_TYPE,
  MYHOME_PROJECT_TYPE,
  MYHOME_REAL_ESTATE_TYPE,
  MYHOME_ROOM_TYPE,
  MYHOME_STATUS,
  MYHOME_STOREROOM_TYPE,
} from "@/lib/myhome-api-constants";

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Exact then substring match against a label→id map. */
export function reverseByLabel(
  map: Record<number, string>,
  label: string
): number | undefined {
  const want = norm(label);
  if (!want) return undefined;

  for (const [id, name] of Object.entries(map)) {
    if (norm(name) === want) return Number(id);
  }
  for (const [id, name] of Object.entries(map)) {
    const n = norm(name);
    if (n.includes(want) || want.includes(n)) return Number(id);
  }
  return undefined;
}

/** Rooms: accept "3", "3 ოთახიანი", etc. */
export function reverseRoomTypeId(rooms: string): number | undefined {
  const digits = rooms.match(/(\d+)/)?.[1] || rooms.trim();
  if (!digits) return undefined;
  if (digits === "10" || digits.includes("10+")) return 11;
  const n = parseInt(digits, 10);
  if (n >= 1 && n <= 5) return n;
  if (n === 6) return 7;
  if (n === 7) return 8;
  if (n === 8) return 9;
  if (n === 9) return 10;
  if (n >= 10) return 11;
  return reverseByLabel(MYHOME_ROOM_TYPE, digits);
}

export function reverseBedroomTypeId(bedrooms: string): number | undefined {
  const digits = bedrooms.match(/(\d+)/)?.[1] || bedrooms.trim();
  if (!digits) return undefined;
  if (digits.includes("10")) return 10;
  const n = parseInt(digits, 10);
  if (n >= 1 && n <= 10) return n;
  return reverseByLabel(MYHOME_BEDROOM_TYPE, digits);
}

export function reverseBathroomTypeId(bathrooms: string): number | undefined {
  const s = bathrooms.trim();
  if (/3\+|3\s*\+/i.test(s)) return 3;
  if (/საერთო/i.test(s)) return 4;
  const n = parseInt(s, 10);
  if (n === 1 || n === 2) return n;
  if (n >= 3) return 3;
  return reverseByLabel(MYHOME_BATHROOM_TYPE, s);
}

export const reverseMaps = {
  currency: (v: string) => reverseByLabel(MYHOME_CURRENCY, v),
  dealType: (v: string) => reverseByLabel(MYHOME_DEAL_TYPE, v),
  propertyType: (v: string) => reverseByLabel(MYHOME_REAL_ESTATE_TYPE, v),
  status: (v: string) => reverseByLabel(MYHOME_STATUS, v),
  condition: (v: string) => reverseByLabel(MYHOME_CONDITION, v),
  projectType: (v: string) => reverseByLabel(MYHOME_PROJECT_TYPE, v),
  heating: (v: string) => reverseByLabel(MYHOME_HEATING_TYPE, v),
  hotWater: (v: string) => reverseByLabel(MYHOME_HOT_WATER_TYPE, v),
  parking: (v: string) => reverseByLabel(MYHOME_PARKING_TYPE, v),
  storeroom: (v: string) => reverseByLabel(MYHOME_STOREROOM_TYPE, v),
  material: (v: string) => reverseByLabel(MYHOME_MATERIAL_TYPE, v),
  doorWindow: (v: string) => reverseByLabel(MYHOME_DOOR_WINDOW_TYPE, v),
};
