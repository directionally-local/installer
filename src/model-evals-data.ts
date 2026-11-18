import { glob, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * `dl evals`, bring your data: the eval sets a team already has, run by promptfoo
 * (model-evals-promptfoo.ts). What promptfoo reads natively (its configs, and tests with `vars`
 * and `__expected`/`assert`) goes to it as is; the rest (OpenAI Evals, Braintrust and LangSmith
 * exports, plain rows, chat transcripts) becomes promptfoo tests: the input as a var, the
 * expected answer as an `__expected` cell, which promptfoo reads as `equals` unless it says
 * otherwise (`contains:Paris`, `factuality:...`). dl doesn't score anything itself.
 */

export interface ChatMessage { role: string; content: string }

/** One row dl translates into a promptfoo test. */
export interface Row {
  input: string | ChatMessage[];
  /** Right answers: any of them (promptfoo `__expected` syntax each). */
  expected?: string[];
  /** `__expected` columns: all must pass. */
  checks?: string[];
  /** "qa.jsonl#2 (math-1)": the test's description, so failures say where they come from. */
  source: string;
}

/** How promptfoo gets a data file. */
export type DataRun =
  /** A promptfoo config: run as is, with dl's provider and grader. */
  | { kind: "config"; config: string }
  /** promptfoo tests (a file, or a list from a JSON wrapper): filled into `{{ var }}`. */
  | { kind: "tests"; prompt: string; tests: string | Array<Record<string, unknown>> }
  /** Rows dl translated: a CSV with an `input` column and `__expected` cells. */
  | { kind: "rows"; rows: Row[] };

export interface DataSet {
  path: string;
  /** "OpenAI Evals JSONL", "promptfoo config (YAML)", "promptfoo tests CSV"... */
  format: string;
  /** Handed to promptfoo as is (true), or translated by dl. */
  native: boolean;
  /** Tests or rows; undefined for a config (promptfoo counts them). */
  cases?: number;
  /** "3 rows without an input skipped". */
  notes: string[];
  /** Files a promptfoo config reads: a folder doesn't load them again as datasets of their own. */
  refs: string[];
  run: DataRun;
}

const INPUT_KEYS = ["input", "prompt", "question", "query", "instruction", "problem", "text"];
const EXPECTED_KEYS = ["expected", "ideal", "answer", "expected_output", "output", "target", "reference", "completion", "solution"];
const DATA_EXTENSIONS = new Set([".jsonl", ".ndjson", ".json", ".csv", ".tsv", ".yaml", ".yml"]);
/** The var a translated row's input goes in. */
export const INPUT_VAR = "input";

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const present = (value: unknown) => value !== undefined && value !== null && value !== "";

export const UNKNOWN_DATA = "not an eval dataset dl recognizes; expected JSONL or JSON rows with input/prompt/question (and expected/ideal/answer/output), "
  + "chat messages, an OpenAI Evals, Braintrust or LangSmith export, a CSV with those columns, promptfoo tests or a promptfoo config";

// ---- Normalizing rows ----------------------------------------------------------------------

/** OpenAI-style messages, LangChain's ({type: "human", data: {content}}) too; undefined if not messages. */
export function messagesOf(value: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const roles: Record<string, string> = { human: "user", ai: "assistant", system: "system", user: "user", assistant: "assistant", developer: "system", tool: "tool" };
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!isObject(item)) return undefined;
    const data = isObject(item.data) ? item.data : item;
    const role = typeof item.role === "string" ? item.role : typeof item.type === "string" ? roles[item.type] : undefined;
    const content = contentText(data.content);
    if (!role || content === undefined) return undefined;
    messages.push({ role: roles[role] ?? role, content });
  }
  return messages;
}

/** A message's content: a string, or the text parts of a list. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
  return undefined;
}

/** A scalar as text, or an object's obvious field: one of `keys`, else its only string field. */
function textOf(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!isObject(value)) return undefined;
  for (const key of keys) if (typeof value[key] === "string" || typeof value[key] === "number") return String(value[key]);
  const strings = Object.values(value).filter((item) => typeof item === "string");
  return strings.length === 1 ? strings[0] as string : undefined;
}

/** What to send: chat messages, or a prompt (from an object, its obvious field). */
function inputOf(value: unknown): string | ChatMessage[] | undefined {
  const messages = messagesOf(value) ?? (isObject(value) ? messagesOf(value.messages) : undefined);
  return messages ?? textOf(value, INPUT_KEYS);
}

/** Right answers: a string, a list of them (OpenAI Evals' ideal), a message, or an object's obvious field. */
function expectedOf(value: unknown): string[] | undefined {
  if (!present(value)) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    const messages = messagesOf(value);
    if (messages) return [messages.at(-1)!.content];
    if (value.every((item) => typeof item === "string" || typeof item === "number")) return value.map(String);
    return [JSON.stringify(value)];
  }
  if (isObject(value)) {
    if (Array.isArray(value.messages)) return expectedOf(value.messages);
    if (typeof value.role === "string" && value.content !== undefined) return expectedOf(contentText(value.content));
    for (const key of EXPECTED_KEYS) if (present(value[key])) return expectedOf(value[key]);
    const fields = Object.values(value).filter(present);
    if (fields.length === 1 && typeof fields[0] !== "object") return expectedOf(fields[0]);
    return [JSON.stringify(value)];
  }
  return undefined;
}

/** The kind of row, for the summary: what tool made this file. */
function rowFormat(row: Record<string, unknown>): string {
  if (isObject(row.inputs)) return "LangSmith";
  if (Array.isArray(row.input) && "ideal" in row) return "OpenAI Evals";
  if ("expected" in row && "input" in row && ("metadata" in row || "_xact_id" in row || "span_id" in row || "dataset_id" in row)) return "Braintrust";
  if (Array.isArray(row.messages)) return "chat";
  return "";
}

/** One row (JSON object or CSV record) as a test to translate; undefined when it has no input. */
export function rowOf(row: unknown): Omit<Row, "source"> & { id?: string } | undefined {
  if (!isObject(row)) return undefined;
  let input: string | ChatMessage[] | undefined;
  let expected: string[] | undefined;
  let inputKey: string | undefined;
  if (isObject(row.inputs)) {
    // LangSmith: {inputs: {...}, outputs: {...}}.
    input = inputOf(row.inputs);
    expected = expectedOf(row.outputs ?? row.reference_outputs);
  } else if (typeof row.instruction === "string" && typeof row.input === "string") {
    // Alpaca: the instruction, then its input.
    input = [row.instruction, row.input].filter(Boolean).join("\n\n");
    inputKey = "input";
  } else if ((inputKey = INPUT_KEYS.find((key) => present(row[key])))) {
    input = inputOf(row[inputKey]);
  } else if (Array.isArray(row.messages)) {
    // A chat transcript: the last assistant message is the answer to the ones before it.
    const messages = messagesOf(row.messages);
    if (messages && messages.length > 1 && messages.at(-1)!.role === "assistant") { input = messages.slice(0, -1); expected = [messages.at(-1)!.content]; }
    else input = messages;
  }
  if (input === undefined || (typeof input === "string" && !input.trim())) return undefined;
  if (!expected) {
    const key = EXPECTED_KEYS.find((name) => name !== inputKey && present(row[name]));
    if (key) expected = expectedOf(row[key]);
  }
  const checks = (typeof row.__expected === "string" ? [row.__expected] : Array.isArray(row.__expected) ? row.__expected : undefined)?.filter((item): item is string => typeof item === "string" && !!item.trim());
  const meta = isObject(row.metadata) ? row.metadata : {};
  const id = row.id ?? meta.id ?? (typeof row.description === "string" ? row.description : undefined);
  return { input, ...(expected?.length ? { expected } : {}), ...(checks?.length ? { checks } : {}), ...(id !== undefined && id !== "" ? { id: String(id) } : {}) };
}

function rowsSet(path: string, rows: unknown[], container: string): DataSet {
  const translated: Row[] = [];
  let noInput = 0;
  let noExpected = 0;
  rows.forEach((row, index) => {
    const source = `${basename(path)}#${index + 1}`;
    const item = rowOf(row);
    if (!item) { noInput++; return; }
    if (!item.expected && !item.checks) { noExpected++; return; }
    const { id, ...rest } = item;
    translated.push({ ...rest, source: id && id !== source ? `${source} (${id})` : source });
  });
  if (!translated.length) throw new Error(`${basename(path)}: ${noInput === rows.length ? UNKNOWN_DATA : "no row has an expected answer to check"}.`);
  const first = rows.find(isObject);
  const kind = first ? rowFormat(first) : "";
  const notes = [
    ...(noInput ? [`${noInput} ${noInput === 1 ? "row" : "rows"} without an input skipped`] : []),
    ...(noExpected ? [`${noExpected} ${noExpected === 1 ? "row" : "rows"} without an expected answer skipped`] : []),
  ];
  return { path, format: kind ? `${kind} ${container}` : container, native: false, cases: translated.length, notes, refs: [], run: { kind: "rows", rows: translated } };
}

// ---- CSV -----------------------------------------------------------------------------------

/** RFC 4180: quoted fields, "" escapes, newlines inside quotes, CRLF. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { field += '"'; at++; } else if (char === '"') quoted = false; else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

/** Cells quoted, quotes doubled: what promptfoo's CSV reader (csv-parse) reads back exactly. */
export function toCsv(rows: ReadonlyArray<readonly string[]>): string {
  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n") + "\n";
}

const csvDelimiter = (text: string) => { const header = text.split(/\r?\n/, 1)[0] ?? ""; return header.includes("\t") && !header.includes(",") ? "\t" : ","; };
const isExpectedColumn = (name: string) => /^__expected\d*$/.test(name.trim());

/** Header columns that make a file an eval CSV. */
function knownColumn(name: string): boolean {
  const key = name.trim().toLowerCase();
  return INPUT_KEYS.includes(key) || ["inputs", "messages"].includes(key) || /^(inputs|outputs)\./.test(key) || isExpectedColumn(key);
}

function csvRecords(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text, csvDelimiter(text));
  const names = (header ?? []).map((name) => name.trim());
  return rows.map((cells) => Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ""])));
}

/** A CSV record as a row: `inputs.x`/`outputs.x` columns (and JSON `inputs` cells) nest like LangSmith's; `__expected` cells are kept as written. */
function csvRow(record: Record<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const checks: string[] = [];
  for (const [column, cell] of Object.entries(record)) {
    const nested = /^(inputs|outputs)\.(.+)$/.exec(column);
    if (nested) { const group = (row[nested[1]!] ??= {}) as Record<string, unknown>; group[nested[2]!] = cell; continue; }
    if (isExpectedColumn(column)) { if (cell.trim()) checks.push(cell); continue; }
    if (column === "__description") { row.description = cell; continue; }
    if (column.startsWith("__")) continue;
    let value: unknown = cell;
    if (/^(inputs|outputs|messages|metadata)$/.test(column) && /^[[{]/.test(cell.trim())) { try { value = JSON.parse(cell); } catch { /* text */ } }
    row[column] = value;
  }
  if (checks.length) row.__expected = checks;
  return row;
}

/** Which var is the prompt: an input-like name, else `messages`, else the only one. */
function promptVar(names: readonly string[]): string | undefined {
  const lower = names.map((name) => name.toLowerCase());
  const known = INPUT_KEYS.find((key) => lower.includes(key)) ?? (lower.includes("messages") ? "messages" : undefined);
  if (known) return names[lower.indexOf(known)];
  return names.length === 1 ? names[0] : undefined;
}

function csvSet(path: string, text: string): DataSet {
  const records = csvRecords(text);
  const columns = Object.keys(records[0] ?? {});
  const tsv = /\.tsv$/i.test(path) || csvDelimiter(text) === "\t";
  const vars = columns.filter((name) => !name.startsWith("__"));
  // promptfoo's own test CSV: vars and `__expected` columns, read by promptfoo itself.
  if (!tsv && columns.some(isExpectedColumn) && !vars.some((name) => /^(inputs|outputs)\./.test(name))) {
    const prompt = promptVar(vars);
    if (!prompt) throw new Error(`${basename(path)}: promptfoo tests with vars ${vars.join(", ")}; dl can't tell which one is the prompt. Name it input, prompt or question, or use a promptfoo config with prompts.`);
    return { path, format: "promptfoo tests CSV", native: true, cases: records.length, notes: [], refs: [], run: { kind: "tests", prompt, tests: path } };
  }
  return rowsSet(path, records.map(csvRow), tsv ? "TSV" : "CSV");
}

// ---- promptfoo -----------------------------------------------------------------------------

const fileRef = (value: unknown): string | undefined => (typeof value === "string" && value.startsWith("file://") ? value.slice("file://".length) : undefined);
const isConfig = (value: unknown): value is Record<string, unknown> => isObject(value) && value.prompts !== undefined && (value.tests !== undefined || value.providers !== undefined || value.defaultTest !== undefined || value.scenarios !== undefined);
const isTest = (value: unknown) => isObject(value) && isObject(value.vars);

/**
 * Where a promptfoo config (or its test files) names a provider of its own besides `providers`
 * (which dl replaces) and `defaultTest.options.provider` (which dl's grader overrides): a test's
 * target or an assertion's grader. Those could reach a hosted model, so dl refuses them.
 */
export function providerOverrides(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => providerOverrides(item, `${at}[${index}]`));
  if (!isObject(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = at ? `${at}.${key}` : key;
    if (here === "providers" || here === "defaultTest.options.provider" || here === "targets") continue;
    if ((key === "provider" || key === "providers") && present(child)) { found.push(here); continue; }
    found.push(...providerOverrides(child, here));
  }
  return found;
}

/** A promptfoo config: run as is; the files it names are its own, and no test may pick a provider. */
async function configSet(path: string, config: Record<string, unknown>, read: Reader, container: string): Promise<DataSet> {
  const name = basename(path);
  const refs: string[] = [];
  const overrides = providerOverrides(config);
  for (const item of [config.prompts, config.tests].flatMap((value) => (Array.isArray(value) ? value : [value]))) {
    const spec = fileRef(item) ?? (typeof item === "string" && item === config.tests ? item : undefined);
    if (spec === undefined || /[*?{]/.test(spec)) continue;
    const file = resolve(dirname(path), spec.replace(/:\w+$/, ""));
    refs.push(file);
    if (/\.(ya?ml|json|jsonl)$/i.test(file)) {
      const text = await read(file);
      if (text === undefined) throw new Error(`${name}: can't read ${spec}.`);
      let tests: unknown;
      try { tests = /\.jsonl$/i.test(file) ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown) : parseYaml(text); } catch { continue; }
      overrides.push(...providerOverrides(tests).map((where) => `${spec}${where.startsWith("[") ? "" : "."}${where}`));
    }
  }
  if (overrides.length) {
    throw new Error(`${name}: sets its own provider at ${overrides.slice(0, 3).join(", ")}; dl runs and grades with your own models only, so remove it (dl sets the provider and the grader).`);
  }
  return { path, format: `promptfoo config (${container})`, native: true, notes: [], refs, run: { kind: "config", config: path } };
}

/** A list of promptfoo tests ({vars, assert}): read by promptfoo itself, the prompt var filled in. */
function testsSet(path: string, tests: Array<Record<string, unknown>>, container: string, inline: boolean): DataSet {
  const names = [...new Set(tests.flatMap((test) => Object.keys(test.vars as Record<string, unknown>)))];
  const prompt = promptVar(names);
  if (!prompt) throw new Error(`${basename(path)}: promptfoo tests with vars ${names.join(", ")}; dl can't tell which one is the prompt. Name it input, prompt or question, or use a promptfoo config with prompts.`);
  if (tests.some((test) => typeof (test.vars as Record<string, unknown>)[prompt] === "object")) {
    throw new Error(`${basename(path)}: the ${prompt} var holds a list or object; promptfoo would expand it into several tests. Use a promptfoo config with a chat prompt.`);
  }
  return { path, format: `promptfoo tests ${container}`, native: true, cases: tests.length, notes: [], refs: [], run: { kind: "tests", prompt, tests: inline ? tests : path } };
}

function listSet(path: string, rows: unknown[], container: string, inline: boolean): DataSet {
  const objects = rows.filter(isObject);
  if (objects.length && objects.every(isTest)) return testsSet(path, objects, container, inline);
  return rowsSet(path, rows, container);
}

// ---- One file, by its content --------------------------------------------------------------

type Reader = (path: string) => Promise<string | undefined>;

/** One data file, recognized by its content; throws a one-line error for anything else. */
export async function parseDataFile(path: string, text: string, read: Reader = readText): Promise<DataSet> {
  const body = text.replace(/^﻿/, "");
  const trimmed = body.trim();
  const name = basename(path);
  if (!trimmed) throw new Error(`${name}: empty; ${UNKNOWN_DATA}.`);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let whole: unknown;
    let isWhole = true;
    try { whole = JSON.parse(trimmed); } catch { isWhole = false; }
    if (isWhole) {
      if (isConfig(whole)) return configSet(path, whole, read, "JSON");
      if (Array.isArray(whole)) return listSet(path, whole, "JSON", !/\.json$/i.test(path));
      const object = whole as Record<string, unknown>;
      const list = ["examples", "rows", "data", "records", "items", "samples", "dataset", "tests"].map((key) => object[key]).find(Array.isArray);
      return listSet(path, list ?? [object], "JSON", true);
    }
    // JSONL: one JSON value per line.
    const rows: unknown[] = [];
    for (const [index, line] of body.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { throw new Error(`${name}: line ${index + 1} is not JSON (JSONL needs one JSON object per line).`); }
    }
    // promptfoo reads .jsonl tests; under another name it wouldn't know them.
    return listSet(path, rows, "JSONL", !/\.jsonl$/i.test(path));
  }
  const header = parseCsv(body.split(/\r?\n/, 1)[0] ?? "", csvDelimiter(body))[0] ?? [];
  if (header.some(knownColumn)) return csvSet(path, body);
  let yaml: unknown;
  try { yaml = parseYaml(body); } catch { throw new Error(`${name}: ${UNKNOWN_DATA}.`); }
  if (isConfig(yaml)) return configSet(path, yaml, read, "YAML");
  if (Array.isArray(yaml) && yaml.some(isObject)) return listSet(path, yaml, "YAML", !/\.ya?ml$/i.test(path));
  throw new Error(`${name}: ${UNKNOWN_DATA}.`);
}

const readText: Reader = async (path) => readFile(path, "utf8").catch(() => undefined);

export interface LoadedData { sets: DataSet[]; /** Files in a folder or glob that aren't eval data: "README.json: not ..." */ skipped: string[] }

/**
 * A file, a folder (its data files, recursively) or a glob. A file named on its own must be eval
 * data; in a folder or a glob, files that aren't are listed and passed over.
 */
export async function loadEvalData(pattern: string, read: Reader = readText): Promise<LoadedData> {
  let files: string[];
  let single = false;
  if (/[*?[{]/.test(pattern)) {
    files = [];
    for await (const path of glob(pattern)) files.push(resolve(path));
    files = (await Promise.all(files.map(async (path) => ((await stat(path).catch(() => undefined))?.isFile() ? path : undefined)))).filter((path): path is string => !!path);
  } else {
    const info = await stat(pattern).catch(() => undefined);
    if (!info) throw new Error(`No eval data at ${pattern}.`);
    if (info.isFile()) { files = [pattern]; single = true; } else {
      const entries = await readdir(pattern, { recursive: true, withFileTypes: true });
      files = entries.filter((entry) => entry.isFile() && DATA_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map((entry) => join(entry.parentPath, entry.name))
        .filter((path) => !relative(pattern, path).split("/").some((part) => part.startsWith(".") || part === "node_modules"));
    }
  }
  files.sort();
  if (!files.length) throw new Error(`No eval data files in ${pattern} (looked for ${[...DATA_EXTENSIONS].join(", ")}).`);
  const sets: DataSet[] = [];
  const skipped: string[] = [];
  for (const path of files) {
    const text = await read(path);
    if (text === undefined) throw new Error(`Can't read ${path}.`);
    try { sets.push(await parseDataFile(path, text, read)); } catch (error) {
      if (single) throw error;
      skipped.push((error as Error).message);
    }
  }
  // A promptfoo config's own prompt and test files aren't datasets of their own.
  const refs = new Set(sets.flatMap((set) => set.refs));
  const kept = sets.filter((set) => !refs.has(set.path));
  if (!kept.length) throw new Error(`No eval data dl recognizes in ${pattern}: ${skipped[0] ?? UNKNOWN_DATA}`);
  return { sets: kept, skipped };
}

/** "5 tests from 2 files", then per file: "qa.jsonl: JSONL, 4 tests (translated for promptfoo)". */
export function dataSummary(data: LoadedData, root?: string): string[] {
  const shown = (path: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : basename(path));
  const counted = data.sets.filter((set) => set.cases !== undefined);
  const total = counted.reduce((sum, set) => sum + set.cases!, 0);
  const configs = data.sets.length - counted.length;
  const head = [counted.length ? `${total} ${total === 1 ? "test" : "tests"}` : "", configs ? `${configs} promptfoo ${configs === 1 ? "config" : "configs"}` : ""].filter(Boolean).join(" and ");
  return [`${head} from ${data.sets.length} ${data.sets.length === 1 ? "file" : "files"}, run with promptfoo`,
    ...data.sets.map((set) => `${shown(set.path)}: ${set.format}${set.cases !== undefined ? `, ${set.cases} ${set.cases === 1 ? "test" : "tests"}` : ""}, ${set.native ? "as is" : "translated (equals unless a value says contains:, factuality:...)"}${set.notes.length ? ` (${set.notes.join("; ")})` : ""}`),
    ...data.skipped.map((reason) => `skipped ${reason}`)];
}

/** The directory the data files share, so they show as paths under it. */
export function commonDir(paths: readonly string[]): string {
  let dir = dirname(paths[0] ?? "/");
  while (dir !== "/" && !paths.every((path) => path.startsWith(`${dir}/`))) dir = dirname(dir);
  return dir;
}

// ---- Translated rows as promptfoo tests ----------------------------------------------------

/**
 * Text promptfoo's OpenAI provider would read as chat JSON goes as one user message, so it's
 * sent as written.
 */
function inputCell(input: string | ChatMessage[]): string {
  if (typeof input !== "string") return JSON.stringify(input);
  if (/^\s*[[{]/.test(input)) { try { JSON.parse(input); return JSON.stringify([{ role: "user", content: input }]); } catch { /* plain text */ } }
  return input;
}

/**
 * Translated rows as a promptfoo test CSV: `input`, `__expected` cells (promptfoo reads each as
 * `equals` unless it says otherwise), `__description`. Several right answers: one cell each and
 * a `__threshold` of one in n, so any one passes.
 */
export function rowsCsv(rows: readonly Row[]): string {
  const width = Math.max(1, ...rows.map((row) => (row.checks ?? row.expected ?? []).length));
  const anyOf = rows.some((row) => !row.checks && (row.expected?.length ?? 0) > 1);
  const header = [INPUT_VAR, ...Array.from({ length: width }, (_, index) => `__expected${index + 1}`), ...(anyOf ? ["__threshold"] : []), "__description"];
  const body = rows.map((row) => {
    const values = row.checks ?? row.expected ?? [];
    const threshold = !row.checks && values.length > 1 ? String(Math.floor(1e6 / values.length) / 1e6) : "";
    return [inputCell(row.input), ...Array.from({ length: width }, (_, index) => values[index] ?? ""), ...(anyOf ? [threshold] : []), row.source];
  });
  return toCsv([header, ...body]);
}
