import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

/**
 * CSV tối giản, đúng RFC 4180: quote đầy đủ, escape dấu " thành "".
 * Đủ chắc cho cookie/token có dấu phẩy, xuống dòng, dấu ngoặc kép.
 */

function encodeField(v: string): string {
  if (v === '') return '';
  if (/[",\r\n]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

export function stringifyCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.map(encodeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => encodeField(row[h] ?? '')).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Parse toàn bộ nội dung CSV thành mảng object theo header dòng đầu. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    // bỏ record rỗng cuối file
    if (record.length === 1 && record[0] === '') {
      record = [];
      return;
    }
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      pushField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      pushField();
      pushRecord();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // record cuối chưa có newline
  if (field !== '' || record.length > 0) {
    pushField();
    pushRecord();
  }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0]!;
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r]!;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = rec[idx] ?? '';
    });
    rows.push(obj);
  }
  return { headers, rows };
}

export function readCsvFile(path: string): { headers: string[]; rows: Record<string, string>[] } {
  if (!existsSync(path)) return { headers: [], rows: [] };
  return parseCsv(readFileSync(path, 'utf8'));
}

/** Ghi CSV nguyên tử: viết file tạm rồi rename để không hỏng file khi crash giữa chừng. */
export function writeCsvFile(path: string, headers: string[], rows: Record<string, string>[]): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, stringifyCsv(headers, rows), 'utf8');
  renameSync(tmp, path);
}
