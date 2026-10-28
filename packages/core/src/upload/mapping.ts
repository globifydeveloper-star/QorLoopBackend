import { fieldsFor } from './fields';

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
  /** 0..1, share of required fields mapped by an exact header match */
  confidence: number;
}

/** Best-effort automatic suggestion for the mapping screen. Never applied without user confirmation. */
export function suggestMapping(source: string, headers: string[]): MappingSuggestion {
  const defs = fieldsFor(source);
  const fields: Record<string, string> = {};
  const used = new Set<string>();
  let exact = 0;
  for (const f of defs) {
    const exactHit = headers.find((h) => !used.has(h) && f.hints.some((k) => norm(h) === k));
    const looseHit = exactHit ?? headers.find((h) => !used.has(h) && f.hints.some((k) => norm(h).includes(k)));
    if (looseHit) {
      fields[f.key] = looseHit;
      used.add(looseHit);
      if (exactHit && f.required) exact++;
    }
  }
  const required = defs.filter((f) => f.required);
  return {
    fields,
    missingRequired: required.filter((f) => !fields[f.key]).map((f) => f.key),
    confidence: required.length ? exact / required.length : 0,
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
