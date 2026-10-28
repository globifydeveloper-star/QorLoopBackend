export const MARKETPLACE_IDS = ['talabat', 'snoonu', 'rafeeq', 'keeta'] as const;
export type MarketplaceId = (typeof MARKETPLACE_IDS)[number];

export const ROUNDING_OPTIONS = ['exact', '0.05', '0.25', '0.50'] as const;
export type RoundingOption = (typeof ROUNDING_OPTIONS)[number];

export const RULE_MODES = ['percent', 'amount', 'fixed', 'same'] as const;
export type RuleMode = (typeof RULE_MODES)[number];

export const UPLOAD_SOURCES = ['erp', ...MARKETPLACE_IDS] as const;
export type UploadSource = (typeof UPLOAD_SOURCES)[number];

export const UPLOAD_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxRows: 50_000,
  /** Reject a file when more than this share of its rows is invalid (plan: blueprint J1 error case). */
  maxInvalidRowShare: 0.2,
  extensions: ['.xlsx', '.xls', '.csv'],
} as const;

export const UPLOAD_STATUSES = [
  'uploading',
  'uploaded',
  'processing',
  'needs_mapping',
  'needs_review',
  'applying',
  'applied',
  'rejected',
  'failed',
  'discarded',
] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** Stepper shown in the UI (blueprint): Scan, Check, Detect, Read, Review, Apply. */
export const UPLOAD_STEPS = ['scan', 'check', 'detect', 'read', 'review', 'apply'] as const;
export type UploadStep = (typeof UPLOAD_STEPS)[number];

export const DEFAULT_TENANT_SETTINGS = {
  priceTolerance: 0,
  stockThreshold: 0,
  staleHours: 12,
  mfaRequiredForAll: false,
  analystCanExport: true,
} as const;

/** Retention defaults (open question Q14, build on the default until answered). */
export const RETENTION_DAYS = { uploads: 90, generatedFiles: 30 } as const;
