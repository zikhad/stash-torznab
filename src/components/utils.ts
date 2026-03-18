import { DateTime } from "luxon";

/**
 * Normalizes partial or full ISO-style dates into an HTTP date string.
 * @param input - Date input from Stash.
 */
export function normalizeDate(input: string) {
  if (!input) return DateTime.utc().toHTTP();

  if (/^\d{4}$/.test(input)) {
    return DateTime.fromFormat(input, "yyyy", { zone: "utc" })
      .toHTTP() as string;
  }

  if (/^\d{4}-\d{2}$/.test(input)) {
    return DateTime.fromFormat(input, "yyyy-MM", { zone: "utc" })
      .toHTTP() as string;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return DateTime.fromISO(input, { zone: "utc" })
      .toHTTP() as string;
  }
  return DateTime.fromISO(input).toHTTP() ?? DateTime.utc().toHTTP();

}