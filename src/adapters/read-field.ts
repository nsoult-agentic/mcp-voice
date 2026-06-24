/**
 * Shared raw-record field readers for source adapters.
 *
 * Source adapters take loosely-typed raw records (`Record<string, unknown>`, the
 * intentionally-permissive backing-store shape) and validate the fields they
 * need. These readers centralize that defensive narrowing so every adapter
 * treats absent/wrong-type fields identically.
 */

/** Read a string field from a raw record, or undefined when absent/wrong-type. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
