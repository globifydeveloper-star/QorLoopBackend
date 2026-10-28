import { UPLOAD_LIMITS } from '@qorloop/shared';

export type FileFormat = 'xlsx' | 'xls' | 'csv';

export type SafetyResult = { ok: true; format: FileFormat } | { ok: false; code: SafetyCode; reason: string };

export type SafetyCode =
  | 'bad_extension'
  | 'too_large'
  | 'empty'
  | 'wrong_type'
  | 'encrypted'
  | 'macros'
  | 'zip_bomb'
  | 'binary_csv';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 600 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? '' : fileName.slice(i).toLowerCase();
}

export function isAllowedExtension(fileName: string): boolean {
  return (UPLOAD_LIMITS.extensions as readonly string[]).includes(extensionOf(fileName));
}

interface ZipEntry {
  name: string;
  compressed: number;
  uncompressed: number;
}

/** Reads the zip central directory only (no inflating), enough to spot macros and zip bombs. */
export function readZipDirectory(buf: Buffer): ZipEntry[] | null {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return null;
    const compressed = buf.readUInt32LE(off + 20);
    const uncompressed = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.push({ name: buf.toString('utf8', off + 46, off + 46 + nameLen), compressed, uncompressed });
    off += 46 + nameLen + extraLen + commentLen;
    if (entries.length > MAX_ZIP_ENTRIES) return entries;
  }
  return entries;
}

const utf16 = (s: string) => Buffer.from(s, 'utf16le');

/**
 * Step "Scan"/"Check" of the pipeline. Pure and synchronous: extension, size, real file type by magic
 * bytes (never trust the extension or the browser MIME type), macros, encryption, zip bombs.
 */
export function inspectFile(buf: Buffer, fileName: string): SafetyResult {
  if (!isAllowedExtension(fileName)) {
    return { ok: false, code: 'bad_extension', reason: 'Only .xlsx, .xls and .csv files are accepted' };
  }
  if (buf.length === 0) return { ok: false, code: 'empty', reason: 'The file is empty' };
  if (buf.length > UPLOAD_LIMITS.maxBytes) {
    return { ok: false, code: 'too_large', reason: 'The file is larger than 25 MB' };
  }
  const ext = extensionOf(fileName);

  if (buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    if (ext === '.csv') return { ok: false, code: 'wrong_type', reason: 'This is not a CSV file' };
    const entries = readZipDirectory(buf);
    if (!entries) return { ok: false, code: 'wrong_type', reason: 'The workbook is corrupt' };
    if (entries.length > MAX_ZIP_ENTRIES) {
      return { ok: false, code: 'zip_bomb', reason: 'The workbook has too many parts' };
    }
    let total = 0;
    for (const e of entries) {
      total += e.uncompressed;
      if (e.compressed > 0 && e.uncompressed / e.compressed > MAX_COMPRESSION_RATIO && e.uncompressed > 1024 * 1024) {
        return { ok: false, code: 'zip_bomb', reason: 'The workbook is not a normal spreadsheet' };
      }
    }
    if (total > MAX_UNCOMPRESSED_BYTES) {
      return { ok: false, code: 'zip_bomb', reason: 'The workbook expands to an unsafe size' };
    }
    const names = entries.map((e) => e.name.toLowerCase());
    if (names.some((n) => n.endsWith('vbaproject.bin') || n.startsWith('xl/macrosheets/'))) {
      return { ok: false, code: 'macros', reason: 'Files with macros are not accepted' };
    }
    if (!names.includes('xl/workbook.xml')) {
      return { ok: false, code: 'wrong_type', reason: 'This is not an Excel workbook' };
    }
    return { ok: true, format: 'xlsx' };
  }

  if (buf.subarray(0, 8).equals(OLE_MAGIC)) {
    if (ext === '.csv') return { ok: false, code: 'wrong_type', reason: 'This is not a CSV file' };
    // An OOXML (.xlsx) file in an OLE container is a password-protected one.
    if (buf.includes(utf16('EncryptedPackage')) || buf.includes(utf16('EncryptionInfo'))) {
      return { ok: false, code: 'encrypted', reason: 'Password-protected files are not accepted' };
    }
    if (buf.includes(utf16('_VBA_PROJECT')) || buf.includes(utf16('VBA'))) {
      return { ok: false, code: 'macros', reason: 'Files with macros are not accepted' };
    }
    if (ext === '.xlsx') {
      return { ok: false, code: 'wrong_type', reason: 'This is a legacy .xls file with the wrong extension' };
    }
    return { ok: true, format: 'xls' };
  }

  if (ext !== '.csv') {
    return { ok: false, code: 'wrong_type', reason: `This does not look like a real ${ext} workbook` };
  }
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return { ok: false, code: 'binary_csv', reason: 'This is not a text CSV file' };
  return { ok: true, format: 'csv' };
}
