import { MARKETPLACES } from '../constants.js';
import { fileColumns } from '../generated-files.js';
import { UPLOAD_SOURCES, type UploadSource } from './constants.js';
import { fieldsFor } from './fields.js';

/**
 * Templates screen: how Qorloop reads each source file (saved layouts in input_templates) and which columns
 * generated files write back (the latest applied upload's own stored mapping). Pure; no storage of its own.
 */
export const SOURCE_LABELS: Record<UploadSource, string> = { erp: 'ERP', talabat: 'Talabat', snoonu: 'Snoonu', rafeeq: 'Rafeeq', keeta: 'Keeta' };

/** Marketplaces whose file format is not confirmed yet (open gap G4). */
const UNKNOWN_FORMAT: ReadonlySet<string> = new Set(['rafeeq', 'keeta']);

export interface LayoutRow { id: string; tenantId: string | null; source: string; name: string; version: number; fields: unknown; createdAt: Date }
export interface LayoutUsage { usedByUploads: number; lastUsedAt: Date | null; headers: string[] | null }

/** The newest version of each saved layout name; a tenant's layout and a built-in one of the same name stay apart. */
export function currentVersions<T extends { tenantId: string | null; source: string; name: string; version: number }>(layouts: T[]): T[] {
  const best = new Map<string, T>();
  for (const l of layouts) {
    const key = JSON.stringify([l.tenantId, l.source, l.name]);
    const prior = best.get(key);
    if (!prior || l.version > prior.version) best.set(key, l);
  }
  return [...best.values()];
}

/** Every field of the source, with its header or null. Anything but a non-empty string in stored JSON reads as unmapped. */
export function mappingOf(source: string, fields: unknown): Record<string, string | null> {
  const f = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields as Record<string, unknown> : {};
  return Object.fromEntries(fieldsFor(source).map(d => {
    const v = f[d.key];
    return [d.key, typeof v === 'string' && v ? v : null];
  }));
}

export function layoutView(layout: LayoutRow, usage: LayoutUsage) {
  const defs = fieldsFor(layout.source);
  const mapping = mappingOf(layout.source, layout.fields);
  return {
    name: layout.name, version: layout.version, builtIn: layout.tenantId === null, editable: layout.tenantId !== null,
    savedAt: layout.createdAt.toISOString(), lastUsedAt: usage.lastUsedAt?.toISOString() ?? null, usedByUploads: usage.usedByUploads,
    mapping,
    mapped: defs.filter(d => mapping[d.key]).map(d => d.key),
    missingRequired: defs.filter(d => d.required && !mapping[d.key]).map(d => d.key),
    /** Columns of the last file read with this layout (any version): the choices for an edit. Null when none is on record. */
    headers: usage.headers,
  };
}
export type LayoutView = ReturnType<typeof layoutView>;

export function notSetUpReason(source: UploadSource): string {
  const label = SOURCE_LABELS[source];
  return UNKNOWN_FORMAT.has(source)
    ? `No saved layout yet. Qorloop does not know the ${label} file format; upload a ${label} file and save its column mapping to set it up.`
    : `No saved layout yet. Upload a ${label} file and choose to save its column mapping.`;
}

export interface AppliedUpload { fileName: string; appliedAt: Date | null; mapping: unknown; headers: unknown; templateId: string | null }

/**
 * What generated files write for a marketplace, derived exactly as generation does: from the latest applied upload's
 * stored mapping and headers (not from the saved layout). The file itself is checked again when a file is generated.
 */
export function outgoingView(source: UploadSource, applied: AppliedUpload | null, layoutOf: (templateId: string) => { name: string; version: number; current: boolean } | null) {
  const label = SOURCE_LABELS[source];
  if (!applied) {
    return { status: 'not_ready' as const, reason: `No ${label} file has been applied yet. Apply one to generate ${label} files.`, basedOn: null, columns: null };
  }
  const c = fileColumns(applied.mapping);
  const basedOn = {
    fileName: applied.fileName, appliedAt: applied.appliedAt?.toISOString() ?? null,
    layout: applied.templateId ? layoutOf(applied.templateId) : null,
  };
  const columns = { matchBy: { field: c.identifierField, header: c.identifier }, price: c.price, availability: c.availability };
  const headers = Array.isArray(applied.headers) ? applied.headers.filter((h): h is string => typeof h === 'string') : [];
  const mapped = [c.identifier, c.price, c.availability];
  let reason: string | null = null;
  if (mapped.some(h => !h)) reason = `The last applied ${label} file has no identifying, price or availability column mapped. Apply a ${label} file with those columns.`;
  else if (mapped.some(h => headers.filter(x => x === h).length !== 1) || new Set(mapped).size !== 3) {
    reason = `The last applied ${label} file's columns no longer fit its mapping. Upload a fresh ${label} file.`;
  }
  return { status: reason ? 'not_ready' as const : 'ready' as const, reason, basedOn, columns };
}
export type OutgoingView = ReturnType<typeof outgoingView>;

export function sourceEntry(source: UploadSource, layouts: LayoutView[], outgoing: OutgoingView | null) {
  const ordered = [...layouts].sort((a, b) =>
    (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name));
  return {
    source, label: SOURCE_LABELS[source],
    status: ordered.length ? 'set_up' as const : 'not_set_up' as const,
    reason: ordered.length ? null : notSetUpReason(source),
    fields: fieldsFor(source).map(f => ({ key: f.key, label: f.label, required: f.required })),
    layouts: ordered,
    /** Null for ERP: Qorloop never writes ERP files. */
    outgoing,
  };
}
export type TemplateSourceEntry = ReturnType<typeof sourceEntry>;

export const TEMPLATE_SOURCES = UPLOAD_SOURCES;
export const isMarketplace = (source: string) => (MARKETPLACES as readonly string[]).includes(source);
