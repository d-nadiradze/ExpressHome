/**
 * When an API prefill fails, the runner can repeat the attempt in a browser.
 * That is only safe while nothing has been created on the target site yet:
 * `statements/create` (myhome) and the paid publish call (ss.ge) both leave a
 * listing behind, so a browser retry after either one posts the same listing
 * twice — and, on ss.ge, pays for it twice.
 */

export interface PrefillAttemptResult {
  success: boolean;
  postUrl?: string;
  error?: string;
  /** Set by the API prefills once the target site holds the listing. */
  listingCreated?: boolean;
}

export function shouldRetryInBrowser(
  result: PrefillAttemptResult,
  fallbackEnabled: boolean
): boolean {
  if (result.success) return false;
  if (result.listingCreated) return false;
  return fallbackEnabled;
}

/**
 * A failed attempt that already created the listing is reported as a partial
 * success — the failing step is flagged as a warning and the URL still reaches
 * the user — instead of a plain failure with nothing to show.
 */
export function isPartialSuccess(result: PrefillAttemptResult): boolean {
  return !result.success && result.listingCreated === true;
}
