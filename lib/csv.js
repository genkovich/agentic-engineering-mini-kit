// CSV for the spreadsheet the developer already has open. RFC 4180: CRLF line ends, a header
// row first, and a field is quoted only when it has to be — when it contains a comma, a double
// quote, a carriage return or a newline — with every inner quote doubled.
//
// Source-agnostic and dependency-free: it is handed columns and plain row objects and knows
// nothing about sessions. `columns` is `[{ key, header }]`, so the header text and the row key
// stay separate and the column order is the caller's decision.
const NEEDS_QUOTES = /[",\r\n]/;

function field(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!NEEDS_QUOTES.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(columns, rows) {
  const lines = [columns.map((c) => field(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => field(row[c.key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
