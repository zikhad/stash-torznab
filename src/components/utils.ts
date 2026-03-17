import { DateTime } from "luxon";

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