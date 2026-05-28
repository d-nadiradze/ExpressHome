import { google } from "googleapis";
import { decrypt, encrypt } from "@/lib/encryption";
import { getGoogleOAuthClient } from "@/lib/google-oauth";
import { db } from "@/lib/db";

type ListingForSheet = {
  id: string;
  sourceUrl: string;
  title: string | null;
  propertyType: string | null;
  dealType: string | null;
  buildingStatus: string | null;
  condition: string | null;
  city: string | null;
  address: string | null;
  street: string | null;
  streetNumber: string | null;
  cadastralCode: string | null;
  price: string | null;
  pricePerSqm: string | null;
  currency: string | null;
  area: string | null;
  rooms: string | null;
  bedrooms: string | null;
  floor: string | null;
  totalFloors: string | null;
  projectType: string | null;
  bathrooms: string | null;
  balconyArea: string | null;
  verandaArea: string | null;
  loggiaArea: string | null;
  postStatus: string;
  ssgePostStatus: string;
  createdAt: Date;
};

type GoogleAccountForSheets = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiryDate: Date | null;
  defaultSpreadsheetId: string | null;
  defaultSheetTab: string | null;
};

function toCell(value: string | null | undefined): string {
  return value ?? "";
}

const SHEET_HEADERS = [
  "listingId",
  "title",
  "propertyType",
  "dealType",
  "buildingStatus",
  "condition",
  "city",
  "address",
  "street",
  "streetNumber",
  "cadastralCode",
  "price",
  "currency",
  "pricePerSqm",
  "area",
  "rooms",
  "bedrooms",
  "floor",
  "totalFloors",
  "projectType",
  "bathrooms",
  "balconyArea",
  "verandaArea",
  "loggiaArea",
  "myhomePostStatus",
  "ssgePostStatus",
  "sourceUrl",
  "parsedAt",
];

function listingToRow(listing: ListingForSheet): string[] {
  return [
    listing.id,
    toCell(listing.title),
    toCell(listing.propertyType),
    toCell(listing.dealType),
    toCell(listing.buildingStatus),
    toCell(listing.condition),
    toCell(listing.city),
    toCell(listing.address),
    toCell(listing.street),
    toCell(listing.streetNumber),
    toCell(listing.cadastralCode),
    toCell(listing.price),
    toCell(listing.currency),
    toCell(listing.pricePerSqm),
    toCell(listing.area),
    toCell(listing.rooms),
    toCell(listing.bedrooms),
    toCell(listing.floor),
    toCell(listing.totalFloors),
    toCell(listing.projectType),
    toCell(listing.bathrooms),
    toCell(listing.balconyArea),
    toCell(listing.verandaArea),
    toCell(listing.loggiaArea),
    listing.postStatus,
    listing.ssgePostStatus,
    listing.sourceUrl,
    listing.createdAt.toISOString(),
  ];
}

export async function appendListingToGoogleSheet(
  listing: ListingForSheet,
  googleAccount: GoogleAccountForSheets,
  options?: { spreadsheetId?: string; sheetTab?: string }
): Promise<void> {
  const spreadsheetId =
    options?.spreadsheetId?.trim() || googleAccount.defaultSpreadsheetId || "";
  const sheetTab = options?.sheetTab?.trim() || googleAccount.defaultSheetTab || "Sheet1";
  if (!spreadsheetId) {
    throw new Error("Google spreadsheet is not configured for this user");
  }

  const oauth2 = getGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: decrypt(googleAccount.accessToken),
    refresh_token: decrypt(googleAccount.refreshToken),
    expiry_date: googleAccount.tokenExpiryDate?.getTime(),
  });

  await oauth2.getAccessToken();
  const credentials = oauth2.credentials;

  if (credentials.access_token) {
    await db.googleAccount.update({
      where: { userId: googleAccount.userId },
      data: {
        accessToken: encrypt(credentials.access_token),
        tokenExpiryDate: credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : null,
      },
    });
  }

  const sheets = google.sheets({ version: "v4", auth: oauth2 });
  const headerRange = `${sheetTab}!A1:ZZ1`;

  const existingHeader = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange,
  });
  const firstRow = existingHeader.data.values?.[0] ?? [];
  const isHeaderMissing = firstRow.every((v) => !String(v ?? "").trim());

  if (isHeaderMissing) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTab}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetTab}!A:ZZ`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [listingToRow(listing)],
    },
  });
}
