/**
 * Resolve logged-in ss.ge contact phones for API prefill (never parsed seller data).
 */
import type { SsgeDraftPayload } from "@/lib/ssge-api-form-fields";

export function normalizeGeorgianMobile(phone: string): string {
  const nine = phone.replace(/\D/g, "").slice(-9);
  return nine.length === 9 && nine.startsWith("5") ? nine : "";
}

export function buildSsgePhoneNumbers(
  phone: string
): SsgeDraftPayload["phoneNumbers"] | undefined {
  const normalized = normalizeGeorgianMobile(phone);
  if (!normalized) return undefined;
  return [
    {
      phoneNumber: normalized,
      isMain: true,
      hasViber: true,
      hasWhatsapp: true,
      isApproved: false,
    },
  ];
}

function mapPhoneRows(
  phones: unknown
): SsgeDraftPayload["phoneNumbers"] | undefined {
  if (!Array.isArray(phones) || phones.length === 0) return undefined;
  const mapped = phones
    .map((row) => {
      const entry = row as Record<string, unknown>;
      const phoneNumber = normalizeGeorgianMobile(
        String(entry.phoneNumber ?? entry.phone ?? "")
      );
      if (!phoneNumber) return null;
      return {
        phoneNumber,
        isMain: Boolean(entry.isMain ?? entry.is_main ?? phones[0] === row),
        hasViber: Boolean(entry.hasViber ?? entry.has_viber ?? true),
        hasWhatsapp: Boolean(entry.hasWhatsapp ?? entry.has_whatsapp ?? true),
        isApproved: Boolean(entry.isApproved ?? entry.is_approved ?? false),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return mapped.length > 0 ? mapped : undefined;
}

/** Phones on an existing draft (get-draft / publish merge). */
export function draftAccountPhones(
  draft: Record<string, unknown> | null
): SsgeDraftPayload["phoneNumbers"] | undefined {
  if (!draft) return undefined;
  return (
    mapPhoneRows(draft.applicationPhones) ??
    mapPhoneRows(draft.phoneNumbers)
  );
}

function extractPhoneFromSessionBody(body: unknown): string {
  const visit = (node: unknown, depth = 0): string => {
    if (!node || depth > 4) return "";
    if (typeof node === "string") return normalizeGeorgianMobile(node);
    if (typeof node !== "object") return "";
    const obj = node as Record<string, unknown>;
    for (const key of [
      "phoneNumber",
      "phone",
      "mobile",
      "mobileNumber",
      "userPhone",
    ]) {
      const v = obj[key];
      if (typeof v === "string") {
        const normalized = normalizeGeorgianMobile(v);
        if (normalized) return normalized;
      }
    }
    for (const value of Object.values(obj)) {
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return "";
  };
  return visit(body);
}

async function fetchSsgeSessionPhone(
  accessToken: string
): Promise<string | undefined> {
  try {
    const res = await fetch("https://home.ss.ge/api/auth/session", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(
        parseInt(process.env.SSGE_API_FETCH_TIMEOUT_MS || "20000", 10)
      ),
    });
    if (!res.ok) return undefined;
    const body = await res.json().catch(() => null);
    const phone = extractPhoneFromSessionBody(body);
    return phone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Account phones for create-draft: draft snapshot → NextAuth session → myhome profile.
 */
export async function resolveSsgeAccountPhones(options: {
  userId: string;
  accessToken: string;
  loadDraft: () => Promise<Record<string, unknown> | null>;
}): Promise<SsgeDraftPayload["phoneNumbers"] | undefined> {
  const draft = await options.loadDraft();
  const fromDraft = draftAccountPhones(draft);
  if (fromDraft?.length) {
    console.log(
      `[ss.ge API prefill] ${fromDraft.length} account phone(s) from draft`
    );
    return fromDraft;
  }

  const sessionPhone = await fetchSsgeSessionPhone(options.accessToken);
  if (sessionPhone) {
    const built = buildSsgePhoneNumbers(sessionPhone);
    if (built?.length) {
      console.log(
        `[ss.ge API prefill] account phone from ss.ge session (${sessionPhone.slice(0, 3)}…)`
      );
      return built;
    }
  }

  const { db } = await import("@/lib/db");
  const { decrypt } = await import("@/lib/encryption");
  const { fetchMyhomeAccountContact } = await import("@/lib/myhome-api-prefill");

  const myhome = await db.myhomeAccount.findUnique({
    where: { userId: options.userId },
  });
  if (myhome) {
    const contact = await fetchMyhomeAccountContact({
      email: myhome.myhomeEmail,
      password: decrypt(myhome.myhomePassword),
    });
    const built = buildSsgePhoneNumbers(contact.phone || "");
    if (built?.length) {
      console.log(
        `[ss.ge API prefill] account phone from myhome profile (${built[0]!.phoneNumber.slice(0, 3)}…)`
      );
      return built;
    }
    if (contact.error) {
      console.warn(
        `[ss.ge API prefill] myhome profile phone unavailable: ${contact.error}`
      );
    }
  }

  console.warn(
    "[ss.ge API prefill] no account phone resolved — listing may publish without contact"
  );
  return undefined;
}
