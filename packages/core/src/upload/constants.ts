export const UPLOAD_SOURCES = ['erp', 'talabat', 'snoonu', 'rafeeq', 'keeta'] as const;
export type UploadSource = (typeof UPLOAD_SOURCES)[number];

export const UPLOAD_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxRows: 50_000,
  /** Reject a file when more than this share of its rows is invalid (blueprint J1 error case). */
  maxInvalidRowShare: 0.2,
  extensions: ['.xlsx', '.xls', '.csv'],
} as const;

export const UPLOAD_STATUSES = [
  'uploading', 'uploaded', 'processing', 'needs_mapping', 'needs_review',
  'applying', 'applied', 'rejected', 'failed', 'discarded',
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** Stepper shown in the UI (blueprint): Scan, Check, Detect, Read, Review, Apply. */
export const UPLOAD_STEPS = ['scan', 'check', 'detect', 'read', 'review', 'apply'] as const;
export type UploadStep = (typeof UPLOAD_STEPS)[number];

/** Retention defaults (open question Q14, build on the default until answered). */
export const RETENTION_DAYS = { uploads: 90, generatedFiles: 30 } as const;
