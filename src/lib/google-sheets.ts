import { google } from "googleapis";
import { decrypt, encrypt } from "@/lib/encryption";
import { getGoogleOAuthClient } from "@/lib/google-oauth";
import { db } from "@/lib/db";
import {
  BROKER_SHEET_COLUMN_COUNT,
  BROKER_SHEET_HEADERS,
  listingToBrokerSheetRow,
  padBrokerSheetRow,
  type BrokerSheetListing,
} from "@/lib/google-sheets-row";

type GoogleAccountForSheets = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiryDate: Date | null;
  defaultSpreadsheetId: string | null;
  defaultSheetTab: string | null;
};

export async function appendListingToGoogleSheet(
  listing: BrokerSheetListing,
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
  const headerRange = `${sheetTab}!A1:P1`;

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
      requestBody: { values: [[...BROKER_SHEET_HEADERS]] },
    });
    await styleBrokerSheetHeader(sheets, spreadsheetId, sheetTab);
  }

  const row = padBrokerSheetRow(listingToBrokerSheetRow(listing));
  const nextRow = await findNextDataRow(sheets, spreadsheetId, sheetTab);

  // Explicit A:P update — append() trims leading empty cells and shifts columns right.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTab}!A${nextRow}:P${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/** First empty row at or below row 2 (row 1 = headers). */
async function findNextDataRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetTab: string
): Promise<number> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTab}!A2:P`,
  });
  const values = res.data.values ?? [];
  if (values.length === 0) return 2;

  for (let i = values.length - 1; i >= 0; i--) {
    const cells = values[i] ?? [];
    const hasData = cells.some((c) => String(c ?? "").trim() !== "");
    if (hasData) return i + 3;
  }
  return 2;
}

/** Yellow header row to match broker template. */
async function styleBrokerSheetHeader(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetTab: string
): Promise<void> {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });
    const sheet = meta.data.sheets?.find(
      (s) => s.properties?.title === sheetTab
    );
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId == null) return;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: BROKER_SHEET_COLUMN_COUNT,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 0.95, blue: 0.6 },
                  textFormat: { bold: true },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
        ],
      },
    });
  } catch (err) {
    console.warn("[google-sheets] header styling skipped:", err);
  }
}
