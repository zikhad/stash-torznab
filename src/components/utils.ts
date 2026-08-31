import { DateTime } from "luxon";

/** Escapes text before it is embedded in a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extracts a token from a URL component described by a tracker template.
 * Other template tokens are matched but ignored.
 */
export function extractTemplateToken(
  value: string,
  template: string,
  token: "id" | "passkey",
): string | undefined {
  const requestedToken = `{${token}}`;
  const parts = template.split(/(\{(?:id|passkey)\})/);
  const requestedTokenIndex = parts.indexOf(requestedToken);

  if (requestedTokenIndex === -1) return undefined;

  const isTemplateToken = (part: string) => /^\{(?:id|passkey)\}$/.test(part);
  const captureGroup = parts
    .slice(0, requestedTokenIndex + 1)
    .filter(isTemplateToken)
    .length;
  const pattern = parts
    .map((part) => isTemplateToken(part) ? "([^/?#&]+)" : escapeRegExp(part))
    .join("");
  const match = value.match(new RegExp(`^${pattern}$`));
  const extractedValue = match?.[captureGroup];

  return extractedValue ? decodeURIComponent(extractedValue) : undefined;
}

/**
 * Normalizes partial/full scene dates into RFC-style HTTP date strings.
 * @param input - Raw date value from scene metadata.
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
