import { fieldsFor } from './fields.js';

export interface TemplateLike {
  id: string;
  source: string;
  name: string;
  version: number;
  fields: Record<string, string>;
  signature: string[];
}

const norm = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase();

export function signatureMatches(signature: string[], headers: string[]): boolean {
  if (signature.length === 0) return false;
  const set = new Set(headers.map(norm));
  return signature.every((s) => set.has(norm(s)));
}

/** A saved mapping matches when ALL its signature headers are present (case- and space-insensitive). */
export function detectTemplate<T extends TemplateLike>(templates: T[], source: string, headers: string[]): T | null {
  const candidates = templates
    .filter((t) => t.source === source && signatureMatches(t.signature, headers))
    // most specific (longest signature) first, then newest version
    .sort((a, b) => b.signature.length - a.signature.length || b.version - a.version);
  return candidates[0] ?? null;
}

/**
 * Wrong-file guard (docs 5.6): before mapping an unrecognised file, check it against the OTHER sources'
 * mappings. Returns the source it looks like, or null.
 */
export function looksLikeOtherSource<T extends TemplateLike>(templates: T[], source: string, headers: string[]): string | null {
  const hit = templates.find((t) => t.source !== source && signatureMatches(t.signature, headers));
  return hit ? hit.source : null;
}

export interface MappingSuggestion {
  fields: Record<string, string>;
  /** required fields we could not map */
  missingRequired: string[];
  /** 0..1, share of required fields mapped by a strong match (whole header, or the header's leading words) */
  confidence: number;
}

/** Lower-case words only: "Barcode(UniqueIdentifier)" -> "barcode uniqueidentifier", "name_ar" -> "name ar". */
const words = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Hints this short ('id', 'upc', 'qty', ...) only match whole words, never inside another word. */
const SHORT_HINT = 3;

/**
 * How well a header matches a hint, strongest first: 1 = the whole header, 2 = the header's leading
 * words ("Price For Branch X"), 3 = whole words anywhere ("Item Name"), 4 = inside a word (long hints
 * only). 0 = no match.
 */
function matchTier(header: string, hint: string): number {
  const h = words(header);
  const k = words(hint);
  if (!k) return 0;
  if (h === k) return 1;
  if (h.startsWith(`${k} `)) return 2;
  if (` ${h} `.includes(` ${k} `)) return 3;
  if (k.length > SHORT_HINT && h.includes(k)) return 4;
  return 0;
}

const STRONG_TIER = 2;

/** Best-effort automatic suggestion for the mapping screen. Never applied without user confirmation. */
export function suggestMapping(source: string, headers: string[]): MappingSuggestion {
  const defs = fieldsFor(source);
  const fields: Record<string, string> = {};
  const used = new Set<string>();
  let strong = 0;
  for (const f of defs) {
    // the strongest tier over all free headers and hints wins; on a tie the earlier header wins
    let best: { header: string; tier: number } | null = null;
    for (const h of headers) {
      if (used.has(h)) continue;
      for (const k of f.hints) {
        const tier = matchTier(h, k);
        if (tier && (!best || tier < best.tier)) best = { header: h, tier };
      }
    }
    if (best) {
      fields[f.key] = best.header;
      used.add(best.header);
      if (best.tier <= STRONG_TIER && f.required) strong++;
    }
  }
  const required = defs.filter((f) => f.required);
  return {
    fields,
    missingRequired: required.filter((f) => !fields[f.key]).map((f) => f.key),
    confidence: required.length ? strong / required.length : 0,
  };
}

export function validateMapping(source: string, fields: Record<string, string>, headers: string[]): string[] {
  const problems: string[] = [];
  const set = new Set(headers);
  for (const f of fieldsFor(source)) {
    const col = fields[f.key];
    if (f.required && !col) problems.push(`${f.label} must be mapped`);
    if (col && !set.has(col)) problems.push(`Column "${col}" is not in the file`);
  }
  const cols = Object.values(fields);
  if (new Set(cols).size !== cols.length) problems.push('A column can only be mapped to one field');
  return problems;
}

/** Headers of the mapped columns become the layout signature of the saved mapping. */
export function signatureFor(fields: Record<string, string>, headers: string[]): string[] {
  const set = new Set(headers);
  return Object.values(fields).filter((h) => set.has(h));
}
