export type PrefillPlatform = "myhome" | "ssge";
export type PrefillStepStatus = "pending" | "running" | "done" | "error";

export interface PrefillStepDef {
  id: string;
  label: string;
}

export interface PrefillStep extends PrefillStepDef {
  status: PrefillStepStatus;
  detail?: string;
}

export const MYHOME_PREFILL_STEPS: PrefillStepDef[] = [
  { id: "browser", label: "Starting browser" },
  { id: "login", label: "Signing in to myhome.ge" },
  { id: "form", label: "Opening listing form" },
  { id: "fields", label: "Filling property details" },
  { id: "amenities", label: "Additional parameters" },
  { id: "images", label: "Uploading photos" },
  { id: "publish", label: "Publishing listing" },
  { id: "checkout", label: "Checkout & payment" },
];

export const SSGE_PREFILL_STEPS: PrefillStepDef[] = [
  { id: "browser", label: "Starting browser" },
  { id: "login", label: "Signing in to ss.ge" },
  { id: "step1", label: "Category & deal type" },
  { id: "step2", label: "Photos" },
  { id: "step3", label: "Location" },
  { id: "step4", label: "Property details" },
  { id: "step5", label: "Amenities & condition" },
  { id: "step6", label: "Description" },
  { id: "step7", label: "Price" },
  { id: "step8", label: "Contact & publish" },
];

/**
 * The API paths drive the sites over HTTP, so the browser-only stages above
 * never happen and their own stages ("draft", "save") have no counterpart there.
 * A run swaps the list in once it knows which path it is taking, otherwise the
 * panel shows rows that can never complete.
 */
export const MYHOME_API_PREFILL_STEPS: PrefillStepDef[] = [
  { id: "login", label: "Signing in to myhome.ge" },
  { id: "fields", label: "Filling property details" },
  { id: "amenities", label: "Additional parameters" },
  { id: "images", label: "Uploading photos" },
  { id: "publish", label: "Publishing listing" },
  { id: "checkout", label: "Checkout & payment" },
];

export const SSGE_API_PREFILL_STEPS: PrefillStepDef[] = [
  { id: "login", label: "Signing in to ss.ge" },
  { id: "location", label: "Resolving location" },
  { id: "draft", label: "Creating draft" },
  { id: "images", label: "Uploading photos" },
  { id: "save", label: "Saving listing details" },
  { id: "publish", label: "Publishing listing" },
];

export function defaultPrefillSteps(platform: PrefillPlatform): PrefillStep[] {
  const defs = platform === "myhome" ? MYHOME_PREFILL_STEPS : SSGE_PREFILL_STEPS;
  return defs.map((s) => ({ ...s, status: "pending" as const }));
}

export function toPrefillSteps(defs: PrefillStepDef[]): PrefillStep[] {
  return defs.map((s) => ({ ...s, status: "pending" as const }));
}
