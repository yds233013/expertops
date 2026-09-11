/**
 * CSV reading and writing.
 *
 * The important part is `escapeCell`. A spreadsheet treats a cell beginning
 * with `=`, `+`, `-`, `@`, or a tab/carriage return as a formula, so a value
 * typed into this application by a user could execute when the export is opened
 * elsewhere. Every exported cell is neutralised before quoting.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** Control characters that should never survive into an exported cell. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

/**
 * Neutralise a cell against spreadsheet formula injection.
 *
 * Prefixing with a single quote is the conventional fix: Excel, LibreOffice and
 * Google Sheets all read the result as literal text. The quote sits inside the
 * CSV quoting, so the file stays valid CSV.
 */
export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Strip control characters first, so a leading NUL cannot hide a formula
  // trigger from the check below.
  const text = String(value).replace(CONTROL_CHARACTERS, '');

  if (text.length > 0 && FORMULA_TRIGGERS.includes(text[0]!)) {
    return `'${text}`;
  }
  return text;
}

/** Quote a cell for CSV, doubling embedded quotes. */
export function quoteCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsvRow(cells: unknown[]): string {
  return cells.map((cell) => quoteCell(escapeCell(cell))).join(',');
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [toCsvRow(headers), ...rows.map(toCsvRow)];
  // CRLF is what spreadsheet software expects.
  return `${lines.join('\r\n')}\r\n`;
}

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Rows whose column count did not match the header. */
  malformed: Array<{ line: number; raw: string; reason: string }>;
}

/**
 * Parse CSV text.
 *
 * Handles quoted fields, embedded commas, doubled quotes and both line endings.
 * Deliberately small: this reads a human-prepared expert list, not arbitrary
 * third-party data.
 */
export function parseCsv(text: string): ParsedCsv {
  const rawRows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Ignore a trailing blank line.
    if (row.length > 1 || row[0] !== '') rawRows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  if (rawRows.length === 0) {
    return { headers: [], rows: [], malformed: [] };
  }

  const headers = rawRows[0]!.map((header) => header.trim());
  const rows: Array<Record<string, string>> = [];
  const malformed: ParsedCsv['malformed'] = [];

  for (let index = 1; index < rawRows.length; index += 1) {
    const cells = rawRows[index]!;
    if (cells.length !== headers.length) {
      malformed.push({
        line: index + 1,
        raw: cells.join(','),
        reason: `Expected ${headers.length} columns, found ${cells.length}.`,
      });
      continue;
    }
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      record[header] = (cells[column] ?? '').trim();
    });
    rows.push(record);
  }

  return { headers, rows, malformed };
}
