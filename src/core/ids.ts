/**
 * Compact identifiers. Projects read as P-018; handoffs as #42.
 * V2 sessions will read as 018-A, 018-B — hence the zero-padded project number.
 */
export function projectCode(id: number): string {
  return `P-${String(id).padStart(3, "0")}`;
}

export function handoffCode(id: number): string {
  return `#${id}`;
}

/** Accepts "18", "#18", "P-018", "018" → 18. */
export function parseId(input: string | number): number | null {
  if (typeof input === "number") return Number.isInteger(input) && input > 0 ? input : null;
  const m = String(input).trim().match(/^(?:#|p-?|h-?)?0*(\d+)$/i);
  return m ? Number(m[1]) : null;
}
