import type { DictionaryTermInput, TermLanguage } from "@lvf/shared";

const LANGUAGES: readonly string[] = ["ru", "en", "hy", "mixed"];

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts: Array<[string, number]> = [
    [",", (firstLine.match(/,/g) ?? []).length],
    [";", (firstLine.match(/;/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const best = counts[0];
  return best && best[1] > 0 ? best[0] : ",";
}

/** RFC 4180 parser: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || (row[0] ?? "").trim().length > 0) rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const char = source[index] ?? "";

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/**
 * Undoes the leading apostrophe core adds in front of a cell that a spreadsheet would
 * evaluate as a formula, so exporting and re-importing a term is lossless.
 */
function unguardFormulaCell(text: string): string {
  return /^'[=+\-@]/.test(text) ? text.slice(1) : text;
}

function parseAliases(cell: string): string[] {
  return cell
    .split(/[;|]/)
    .map((alias) => unguardFormulaCell(alias.trim()))
    .filter((alias) => alias.length > 0);
}

function parseEnabled(cell: string | undefined): boolean {
  if (cell === undefined) return true;
  const normalized = cell.trim().toLowerCase();
  if (normalized === "") return true;
  return !["0", "false", "no", "off", "нет", "выкл"].includes(normalized);
}

/** An absent or malformed cell means "unranked" — never a rejected row. */
function parsePriority(cell: string | undefined): number {
  const value = Number.parseInt((cell ?? "").trim(), 10);
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

function parseLanguage(cell: string | undefined): TermLanguage | undefined {
  const normalized = (cell ?? "").trim().toLowerCase();
  return LANGUAGES.includes(normalized) ? (normalized as TermLanguage) : undefined;
}

const HEADER_ALIASES: Record<string, string> = {
  canonical: "canonical",
  term: "canonical",
  слово: "canonical",
  термин: "canonical",
  aliases: "aliases",
  alias: "aliases",
  синонимы: "aliases",
  category: "category",
  категория: "category",
  language: "language",
  lang: "language",
  язык: "language",
  notes: "notes",
  note: "notes",
  заметки: "notes",
  enabled: "enabled",
  active: "enabled",
  включен: "enabled",
  priority: "priority",
  prio: "priority",
  приоритет: "priority",
};

/**
 * Converts CSV rows into the JSON import shape core accepts. A header row is used
 * when recognised; otherwise the fixed order
 * `canonical, aliases, category, language, notes, enabled, priority` is assumed.
 */
export function csvToTerms(rows: string[][]): DictionaryTermInput[] {
  if (rows.length === 0) return [];

  const first = rows[0] ?? [];
  const normalizedHeader = first.map((cell) => cell.trim().toLowerCase());
  const looksLikeHeader = normalizedHeader.some((cell) => HEADER_ALIASES[cell] === "canonical");

  const columns = new Map<string, number>();
  if (looksLikeHeader) {
    normalizedHeader.forEach((cell, position) => {
      const key = HEADER_ALIASES[cell];
      if (key && !columns.has(key)) columns.set(key, position);
    });
  } else {
    ["canonical", "aliases", "category", "language", "notes", "enabled", "priority"].forEach((key, position) => {
      columns.set(key, position);
    });
  }

  const dataRows = looksLikeHeader ? rows.slice(1) : rows;
  const terms: DictionaryTermInput[] = [];

  for (const row of dataRows) {
    const cell = (key: string): string | undefined => {
      const position = columns.get(key);
      return position === undefined ? undefined : row[position];
    };

    const canonical = unguardFormulaCell((cell("canonical") ?? "").trim());
    if (canonical.length === 0) continue;

    const language = parseLanguage(cell("language"));
    const category = unguardFormulaCell((cell("category") ?? "").trim());
    const notes = unguardFormulaCell((cell("notes") ?? "").trim());

    terms.push({
      canonical,
      aliases: parseAliases(cell("aliases") ?? ""),
      enabled: parseEnabled(cell("enabled")),
      priority: parsePriority(cell("priority")),
      ...(category ? { category } : {}),
      ...(language ? { language } : {}),
      ...(notes ? { notes } : {}),
    });
  }

  return terms;
}

/** Accepts either `{ terms: [...] }` or a bare array of terms. */
export function jsonToTerms(text: string): DictionaryTermInput[] {
  const parsed: unknown = JSON.parse(text);
  const rawList: unknown = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as { terms?: unknown; items?: unknown }).terms ??
        (parsed as { items?: unknown }).items)
      : undefined;

  if (!Array.isArray(rawList)) {
    throw new Error('Expected a JSON array of terms or an object with a "terms" array.');
  }

  const terms: DictionaryTermInput[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const canonical = typeof record.canonical === "string" ? record.canonical.trim() : "";
    if (canonical.length === 0) continue;

    const aliases = Array.isArray(record.aliases)
      ? record.aliases.filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter(Boolean)
      : [];
    const category = typeof record.category === "string" ? record.category.trim() : "";
    const notes = typeof record.notes === "string" ? record.notes.trim() : "";
    const language =
      typeof record.language === "string" && LANGUAGES.includes(record.language)
        ? (record.language as TermLanguage)
        : undefined;

    terms.push({
      canonical,
      aliases,
      enabled: record.enabled === undefined ? true : record.enabled !== false,
      priority: parsePriority(typeof record.priority === "number" ? String(record.priority) : undefined),
      ...(category ? { category } : {}),
      ...(language ? { language } : {}),
      ...(notes ? { notes } : {}),
    });
  }
  return terms;
}
