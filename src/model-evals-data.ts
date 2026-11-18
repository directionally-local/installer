import { glob, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { answerText, connectionError, hasReasoning, localFetch, modelApiBase, NO_THINKING, noTextReason, type FetchModel } from "./model-smoke.js";
import type { ModelDeployment } from "./state.js";

/**
 * `dl evals`, bring your data: the eval sets a team already has (JSONL, CSV, promptfoo configs,
 * OpenAI Evals, Braintrust and LangSmith exports), recognized by their content and run by dl
 * itself against each model's OpenAI-compatible endpoint. Nothing to convert.
 */

export interface ChatMessage { role: string; content: string }
/** A promptfoo-style check on the answer: "contains", "not-regex", "llm-rubric"... */
export interface Assertion { type: string; value?: unknown }

/** One eval case, whatever file it came from. */
export interface EvalCase {
  input: string | ChatMessage[];
  /** Right answers (any of them). */
  expected?: string[];
  assertions?: Assertion[];
  metadata: Record<string, unknown>;
}

export interface DataSet {
  path: string;
  /** "OpenAI Evals JSONL", "promptfoo YAML", "LangSmith CSV"... */
  format: string;
  cases: EvalCase[];
  /** "2 prompts × 10 tests", "3 rows without an input skipped". */
  notes: string[];
  /** Files a promptfoo config read: a folder doesn't load them again as datasets of their own. */
  refs: string[];
}

const INPUT_KEYS = ["input", "prompt", "question", "query", "instruction", "problem", "text"];
const EXPECTED_KEYS = ["expected", "ideal", "answer", "expected_output", "output", "target", "reference", "completion", "solution"];
const DATA_EXTENSIONS = new Set([".jsonl", ".ndjson", ".json", ".csv", ".tsv", ".yaml", ".yml"]);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const present = (value: unknown) => value !== undefined && value !== null && value !== "";

export const UNKNOWN_DATA = "not an eval dataset dl recognizes; expected JSONL or JSON rows with input/prompt/question (and expected/ideal/answer/output), "
  + "chat messages, an OpenAI Evals, Braintrust or LangSmith export, a CSV with those columns, or a promptfoo config";

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

/** promptfoo assertions: objects, or the `__expected` column's "contains: x" strings. */
function assertionsOf(value: unknown): Assertion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assertions = value.map((item) => (typeof item === "string" ? expectedAssertion(item) : isObject(item) && typeof item.type === "string" ? { type: item.type, ...(item.value !== undefined ? { value: item.value } : {}) } : undefined))
    .filter((item): item is Assertion => !!item);
  return assertions.length ? assertions : undefined;
}

/** The kind of row, for the summary: what tool made this file. */
function rowFormat(row: Record<string, unknown>): string {
  if (isObject(row.inputs)) return "LangSmith";
  if (Array.isArray(row.input) && "ideal" in row) return "OpenAI Evals";
  if ("expected" in row && "input" in row && ("metadata" in row || "_xact_id" in row || "span_id" in row || "dataset_id" in row)) return "Braintrust";
  if (Array.isArray(row.messages)) return "chat";
  if (isObject(row.vars)) return "promptfoo tests";
  return "";
}

/** One row (JSON object or CSV record) as a case; undefined when it has no input. */
export function rowCase(row: unknown, metadata: Record<string, unknown> = {}): EvalCase | undefined {
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
  } else if (isObject(row.vars)) {
    // A promptfoo test with no prompt to fill: its one variable is the prompt.
    input = inputOf(row.vars);
  }
  if (input === undefined || (typeof input === "string" && !input.trim())) return undefined;
  if (!expected) {
    const key = EXPECTED_KEYS.find((name) => name !== inputKey && present(row[name]));
    if (key) expected = expectedOf(row[key]);
  }
  const assertions = assertionsOf(row.assert ?? row.assertions);
  const meta = { ...(isObject(row.metadata) ? row.metadata : {}), ...metadata };
  if (row.id !== undefined && meta.id === undefined) meta.id = row.id;
  if (typeof row.description === "string" && meta.id === undefined) meta.id = row.description;
  return { input, ...(expected?.length ? { expected } : {}), ...(assertions ? { assertions } : {}), metadata: meta };
}

function rowsSet(path: string, rows: unknown[], container: string): DataSet {
  const cases: EvalCase[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const item = rowCase(row, { row: index + 1 });
    if (item) cases.push(item); else skipped++;
  });
  if (!cases.length) throw new Error(`${basename(path)}: ${UNKNOWN_DATA}.`);
  const first = rows.find(isObject);
  const kind = first ? rowFormat(first) : "";
  return { path, format: kind ? `${kind} ${container}` : container, cases, notes: skipped ? [`${skipped} ${skipped === 1 ? "row" : "rows"} without an input skipped`] : [], refs: [] };
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

const csvDelimiter = (text: string) => { const header = text.split(/\r?\n/, 1)[0] ?? ""; return header.includes("\t") && !header.includes(",") ? "\t" : ","; };

/** Header columns that make a file an eval CSV. */
function knownColumn(name: string): boolean {
  const key = name.trim().toLowerCase();
  return INPUT_KEYS.includes(key) || ["inputs", "messages", "vars"].includes(key) || /^(inputs|outputs|vars)\./.test(key) || /^__expected\d*$/.test(key);
}

function csvRecords(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text, csvDelimiter(text));
  const names = (header ?? []).map((name) => name.trim());
  return rows.map((cells) => Object.fromEntries(names.map((name, index) => [name, cells[index] ?? ""])));
}

/** promptfoo's CSV tests: columns are vars, `__expected` (and `__expected2`...) assertions. */
function csvTests(records: Array<Record<string, string>>): Array<Record<string, unknown>> {
  return records.map((record) => {
    const vars: Record<string, string> = {};
    const assert: Assertion[] = [];
    let description: string | undefined;
    for (const [column, cell] of Object.entries(record)) {
      if (/^__expected\d*$/.test(column)) { if (cell.trim()) assert.push(expectedAssertion(cell)); } else if (column === "__description") description = cell;
      else if (!column.startsWith("__")) vars[column.replace(/^vars\./, "")] = cell;
    }
    return { vars, ...(assert.length ? { assert } : {}), ...(description ? { description } : {}) };
  });
}

/** A CSV record as a row: `inputs.x`/`outputs.x` columns (and JSON `inputs` cells) nest like LangSmith's. */
function csvRow(record: Record<string, string>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const assert: Assertion[] = [];
  for (const [column, cell] of Object.entries(record)) {
    const nested = /^(inputs|outputs)\.(.+)$/.exec(column);
    if (nested) { const group = (row[nested[1]!] ??= {}) as Record<string, unknown>; group[nested[2]!] = cell; continue; }
    if (/^__expected\d*$/.test(column)) { if (cell.trim()) assert.push(expectedAssertion(cell)); continue; }
    if (column === "__description") { row.description = cell; continue; }
    if (column.startsWith("__")) continue;
    let value: unknown = cell;
    if (/^(inputs|outputs|messages|metadata)$/.test(column) && /^[[{]/.test(cell.trim())) { try { value = JSON.parse(cell); } catch { /* text */ } }
    row[column] = value;
  }
  if (assert.length) row.assert = assert;
  return row;
}

// ---- promptfoo -----------------------------------------------------------------------------

const SUPPORTED = new Set(["equals", "contains", "icontains", "contains-any", "contains-all", "icontains-any", "icontains-all", "regex", "starts-with", "is-json", "contains-json"]);
/** promptfoo assertion types that `__expected` may name ("grade:" and "fn:" are its shorthands). */
const EXPECTED_PREFIXES: Record<string, string> = { grade: "llm-rubric", fn: "javascript", eval: "javascript" };
const KNOWN_TYPES = new Set([...SUPPORTED, "llm-rubric", "javascript", "python", "similar", "levenshtein", "rouge-n", "bleu", "factuality", "model-graded-closedqa",
  "model-graded-factuality", "answer-relevance", "context-faithfulness", "context-recall", "context-relevance", "classifier", "moderation", "webhook", "perplexity",
  "cost", "latency", "is-xml", "contains-xml", "is-sql", "contains-sql", "is-valid-openai-tools-call", "is-valid-openai-function-call", "g-eval", "select-best"]);

/** promptfoo's `__expected` syntax: "contains: Paris", "not-icontains:x", "is-json", "grade: ..."; anything else is "equals". */
export function expectedAssertion(text: string): Assertion {
  const match = /^(not-)?([a-z][a-z0-9-]*)(\([^)]*\))?\s*(?::\s*([\s\S]*))?$/.exec(text.trim());
  if (match) {
    const name = EXPECTED_PREFIXES[match[2]!] ?? match[2]!;
    if (KNOWN_TYPES.has(name) && (match[4] !== undefined || ["is-json", "contains-json", "is-xml", "is-sql", "is-valid-openai-tools-call"].includes(name))) {
      return { type: `${match[1] ?? ""}${name}`, ...(match[4] !== undefined ? { value: match[4] } : {}) };
    }
  }
  return { type: "equals", value: text };
}

/** promptfoo's Nunjucks, the part eval prompts use: {{ var }}, {{ a.b }}, `| dump`, `| trim`. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_, path: string, filter?: string) => {
    let value: unknown = vars;
    for (const key of path.split(".")) value = isObject(value) ? value[key] : undefined;
    if (filter === "dump") return JSON.stringify(value ?? null);
    const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return filter === "trim" ? text.trim() : filter === "upper" ? text.toUpperCase() : filter === "lower" ? text.toLowerCase() : text;
  });
}

type Prompt = { label: string; text?: string; messages?: ChatMessage[] };
type Reader = (path: string) => Promise<string | undefined>;

function promptOf(raw: string, label: string): Prompt {
  if (raw.trim().startsWith("[")) {
    try { const messages = messagesOf(JSON.parse(raw)); if (messages) return { label, messages }; } catch { /* a text prompt */ }
  }
  return { label, text: raw };
}

const fileRef = (value: unknown): string | undefined => (typeof value === "string" && value.startsWith("file://") ? value.slice("file://".length) : undefined);

/** A promptfoo config: `prompts` × `tests` (inline, or a CSV/YAML/JSON file), `defaultTest` merged in. */
async function promptfooSet(path: string, config: Record<string, unknown>, read: Reader, container: string): Promise<DataSet> {
  const base = dirname(path);
  const refs: string[] = [];
  const notes: string[] = [];
  const name = basename(path);
  const load = async (spec: string): Promise<{ file: string; text: string }> => {
    const file = resolve(base, spec);
    const text = await read(file);
    if (text === undefined) throw new Error(`${name}: can't read ${spec}.`);
    refs.push(file);
    return { file, text: text.replace(/^﻿/, "") };
  };
  const prompts: Prompt[] = [];
  for (const item of config.prompts === undefined ? [] : Array.isArray(config.prompts) ? config.prompts : [config.prompts]) {
    const raw = typeof item === "string" ? item : isObject(item) ? (typeof item.raw === "string" ? item.raw : typeof item.id === "string" ? item.id : undefined) : undefined;
    const label = isObject(item) && typeof item.label === "string" ? item.label : undefined;
    if (raw === undefined) { notes.push("a prompt dl can't read skipped"); continue; }
    const spec = fileRef(raw);
    if (spec === undefined) { prompts.push(promptOf(raw, label ?? raw.slice(0, 40))); continue; }
    if (/[*?{]/.test(spec) || /\.(js|cjs|mjs|ts|py)(:\w+)?$/.test(spec)) { notes.push(`prompt ${spec} skipped (globs and code prompts are not supported)`); continue; }
    const { text } = await load(spec);
    if (extname(spec) === ".json") { const prompt = promptOf(text, label ?? spec); prompts.push(prompt); continue; }
    // A text file holds several prompts separated by a line of ---.
    text.split(/^-{3,}\s*$/m).map((part) => part.trim()).filter(Boolean).forEach((part, index, all) => prompts.push(promptOf(part, label ?? (all.length > 1 ? `${spec}#${index + 1}` : spec))));
  }
  const defaults = isObject(config.defaultTest) ? config.defaultTest : {};
  const tests: Array<Record<string, unknown>> = [];
  const testSources = config.tests === undefined ? [] : Array.isArray(config.tests) ? config.tests : [config.tests];
  for (const item of testSources) {
    if (isObject(item)) { tests.push(item); continue; }
    if (typeof item !== "string") continue;
    const spec = fileRef(item) ?? item;
    if (/[*?{]/.test(spec)) { notes.push(`tests ${spec} skipped (globs are not supported)`); continue; }
    const { text } = await load(spec);
    if (/\.(csv|tsv)$/i.test(spec)) tests.push(...csvTests(csvRecords(text)));
    else {
      const parsed = /\.jsonl$/i.test(spec) ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown) : parseYaml(text) as unknown;
      const list = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.tests) ? parsed.tests : [];
      tests.push(...list.filter(isObject));
    }
  }
  if (config.scenarios !== undefined) notes.push("scenarios skipped (not supported)");
  if (!tests.length) tests.push({});
  const cases: EvalCase[] = [];
  for (const [index, test] of tests.entries()) {
    const vars: Record<string, unknown> = { ...(isObject(defaults.vars) ? defaults.vars : {}), ...(isObject(test.vars) ? test.vars : {}) };
    for (const [key, value] of Object.entries(vars)) { const spec = fileRef(value); if (spec !== undefined && !/\.(js|py)$/.test(spec)) vars[key] = (await load(spec)).text; }
    const assertions = [...(assertionsOf(defaults.assert) ?? []), ...(assertionsOf(test.assert) ?? [])]
      .map((assertion) => (typeof assertion.value === "string" ? { ...assertion, value: renderTemplate(assertion.value, vars) } : assertion));
    const meta = { test: index + 1, ...(typeof test.description === "string" ? { id: test.description } : {}) };
    if (!prompts.length) {
      // No prompts: a test's one variable is the prompt.
      const input = inputOf(vars);
      if (input !== undefined) cases.push({ input, ...(assertions.length ? { assertions } : {}), metadata: meta });
      continue;
    }
    for (const prompt of prompts) {
      const input = prompt.messages ? prompt.messages.map((message) => ({ ...message, content: renderTemplate(message.content, vars) })) : renderTemplate(prompt.text!, vars);
      cases.push({ input, ...(assertions.length ? { assertions } : {}), metadata: { ...meta, ...(prompts.length > 1 ? { prompt: prompt.label } : {}) } });
    }
  }
  if (!cases.length) throw new Error(`${name}: a promptfoo config with no prompts or tests dl can run.`);
  notes.unshift(`${prompts.length || 1} ${prompts.length === 1 || !prompts.length ? "prompt" : "prompts"} × ${tests.length} ${tests.length === 1 ? "test" : "tests"}`);
  return { path, format: `promptfoo ${container}`, cases, notes, refs };
}

const isPromptfoo = (value: unknown): value is Record<string, unknown> => isObject(value) && (Array.isArray(value.tests) || typeof value.tests === "string" || (value.prompts !== undefined && (value.providers !== undefined || value.defaultTest !== undefined)));

// ---- One file, by its content --------------------------------------------------------------

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
      if (isPromptfoo(whole)) return promptfooSet(path, whole, read, "JSON");
      if (Array.isArray(whole)) return rowsSet(path, whole, "JSON");
      const object = whole as Record<string, unknown>;
      const list = ["examples", "rows", "data", "records", "items", "samples", "dataset", "tests"].map((key) => object[key]).find(Array.isArray);
      return rowsSet(path, list ?? [object], "JSON");
    }
    // JSONL: one JSON value per line.
    const rows: unknown[] = [];
    for (const [index, line] of body.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { throw new Error(`${name}: line ${index + 1} is not JSON (JSONL needs one JSON object per line).`); }
    }
    return rowsSet(path, rows, "JSONL");
  }
  const header = parseCsv(body.split(/\r?\n/, 1)[0] ?? "", csvDelimiter(body))[0] ?? [];
  if (header.some(knownColumn)) return rowsSet(path, csvRecords(body).map(csvRow), /\.tsv$/i.test(path) ? "TSV" : "CSV");
  let yaml: unknown;
  try { yaml = parseYaml(body); } catch { throw new Error(`${name}: ${UNKNOWN_DATA}.`); }
  if (isPromptfoo(yaml)) return promptfooSet(path, yaml, read, "YAML");
  if (Array.isArray(yaml) && yaml.some(isObject)) return rowsSet(path, yaml, "YAML");
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

/** "120 cases: qa.jsonl (OpenAI Evals JSONL, 100), promptfooconfig.yaml (promptfoo YAML, 20: 2 prompts × 10 tests)". */
export function dataSummary(data: LoadedData, root?: string): string[] {
  const shown = (path: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : basename(path));
  const total = data.sets.reduce((sum, set) => sum + set.cases.length, 0);
  return [`${total} ${total === 1 ? "case" : "cases"} from ${data.sets.length} ${data.sets.length === 1 ? "file" : "files"}`,
    ...data.sets.map((set) => `${shown(set.path)}: ${set.format}, ${set.cases.length} ${set.cases.length === 1 ? "case" : "cases"}${set.notes.length ? ` (${set.notes.join("; ")})` : ""}`),
    ...data.skipped.map((reason) => `skipped ${reason}`)];
}

// ---- Checking an answer --------------------------------------------------------------------

/** Lowercased, whitespace collapsed, quotes and trailing punctuation trimmed. */
export function normalizeAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/^["'`]+/, "").replace(/["'`.!?;:,]+$/, "").trim();
}

const stripFences = (text: string) => text.trim().replace(/^```[\w-]*\n([\s\S]*?)\n?```$/, "$1").trim();
const tryJson = (text: string): { ok: boolean; value?: unknown } => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

/**
 * Whether the answer matches an expected one: equal after normalizing, or containing it as a
 * whole word or phrase ("Paris" in "The capital is Paris.", never "4" in "42"). JSON answers
 * compare as JSON.
 */
export function matchesExpected(output: string, expected: string): boolean {
  const want = normalizeAnswer(expected);
  const got = normalizeAnswer(output);
  if (got === want) return true;
  if (/^[[{]/.test(expected.trim())) {
    const left = tryJson(expected.trim());
    const right = tryJson(stripFences(output));
    if (left.ok && right.ok) return isDeepStrictEqual(left.value, right.value);
  }
  if (!want) return false;
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(got);
}

/** A JSON object or array somewhere in the text (promptfoo's contains-json). */
function containsJson(text: string): boolean {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    for (let end = text.length; end > start; end--) {
      if ((text[end - 1] === "}" || text[end - 1] === "]") && tryJson(text.slice(start, end)).ok) return true;
    }
  }
  return false;
}

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean));

/** One promptfoo assertion on the answer; undefined when dl doesn't support its type. */
export function checkAssertion(assertion: Assertion, output: string): { ok: boolean; reason: string } | undefined {
  const negate = assertion.type.startsWith("not-");
  const type = negate ? assertion.type.slice(4) : assertion.type;
  if (!SUPPORTED.has(type)) return undefined;
  const value = assertion.value;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const lower = output.toLowerCase();
  let ok: boolean;
  switch (type) {
    case "equals":
      ok = typeof value === "string" || typeof value === "number" ? output.trim() === String(value).trim() : (() => { const parsed = tryJson(stripFences(output)); return parsed.ok && isDeepStrictEqual(parsed.value, value); })();
      break;
    case "contains": ok = output.includes(text); break;
    case "icontains": ok = lower.includes(text.toLowerCase()); break;
    case "contains-any": ok = listOf(value).some((item) => output.includes(item)); break;
    case "contains-all": ok = listOf(value).every((item) => output.includes(item)); break;
    case "icontains-any": ok = listOf(value).some((item) => lower.includes(item.toLowerCase())); break;
    case "icontains-all": ok = listOf(value).every((item) => lower.includes(item.toLowerCase())); break;
    case "starts-with": ok = output.trim().startsWith(text); break;
    case "regex":
      try { ok = new RegExp(text).test(output); } catch { return { ok: false, reason: `regex ${text} is not a valid regular expression` }; }
      break;
    case "is-json": ok = tryJson(output.trim()).ok; break;
    default: ok = containsJson(output); break; // contains-json
  }
  if (negate) ok = !ok;
  const shown = type === "is-json" || type === "contains-json" ? "" : type === "regex" ? ` /${text}/` : ` ${clip(text, 40, true)}`;
  return { ok, reason: `${assertion.type}${shown}` };
}

export type CaseStatus = "pass" | "fail" | "no-check";

/**
 * A case's result: its supported assertions when it has any (all must pass); else its expected
 * answers (any may match); else nothing to check. Unsupported assertion types are listed, never
 * counted as passes.
 */
export function scoreCase(item: Pick<EvalCase, "expected" | "assertions">, output: string): { status: CaseStatus; reason?: string; skipped: string[] } {
  const skipped: string[] = [];
  const failed: string[] = [];
  let checked = 0;
  for (const assertion of item.assertions ?? []) {
    const result = checkAssertion(assertion, output);
    if (!result) { skipped.push(assertion.type); continue; }
    checked++;
    if (!result.ok) failed.push(result.reason);
  }
  if (checked) return failed.length ? { status: "fail", reason: `${failed.join(", ")} failed; got ${clip(output, 60, true)}`, skipped } : { status: "pass", skipped };
  if (item.expected?.length) {
    return item.expected.some((expected) => matchesExpected(output, expected))
      ? { status: "pass", skipped }
      : { status: "fail", reason: `expected ${clip(item.expected[0]!, 40, true)}${item.expected.length > 1 ? ` (or ${item.expected.length - 1} more)` : ""}, got ${clip(output, 60, true)}`, skipped };
  }
  return { status: "no-check", skipped };
}

/** One line, at most `max` characters, optionally quoted. */
export function clip(text: string, max: number, quote = false): string {
  const line = text.replace(/\s+/g, " ").trim();
  const cut = line.length > max ? `${line.slice(0, max - 1)}…` : line;
  return quote ? `"${cut}"` : cut;
}

// ---- Running cases against a model ---------------------------------------------------------

export interface CaseResult {
  /** File and row: "qa.jsonl#12". */
  source: string;
  id?: string;
  input: string | ChatMessage[];
  expected?: string[];
  output?: string;
  /** Why there was no answer: HTTP error, timeout, only thinking. */
  error?: string;
  status: CaseStatus;
  reason?: string;
}

export interface DataRunResult {
  cases: CaseResult[];
  checked: number;
  passed: number;
  noCheck: number;
  errors: number;
  /** Unsupported assertion types and how often they were skipped. */
  skipped: Record<string, number>;
  timedOut: boolean;
  /** passed / checked; undefined when nothing was checkable. */
  score?: number;
}

export interface DataRunOptions {
  fetch?: FetchModel;
  /** Requests at once (4). */
  concurrency?: number;
  /** How long one case may take (120 s: a cold model's first answer can take a minute). */
  caseTimeoutMs?: number;
  maxTokens?: number;
  /** No case starts after this time (ms since the epoch): the run's --timeout. */
  deadline?: number;
  now?: () => number;
}

export const DATA_CONCURRENCY = 4;
export const CASE_TIMEOUT_MS = 120_000;
export const DATA_MAX_TOKENS = 1024;

/** A case's place in its file, for the output and the results file. */
export function caseSource(set: DataSet, item: EvalCase, root?: string): string {
  const file = root && set.path.startsWith(`${root}/`) ? set.path.slice(root.length + 1) : basename(set.path);
  const at = item.metadata.row ?? item.metadata.test;
  return `${file}${at !== undefined ? `#${String(at)}` : ""}${typeof item.metadata.prompt === "string" ? ` [${item.metadata.prompt}]` : ""}`;
}

/**
 * Every case against one model's /v1/chat/completions: temperature 0, the served model id,
 * thinking off like dl's smoke tests (and any <think> block stripped), a few at a time.
 */
export async function runDataCases(cases: ReadonlyArray<{ source: string; item: EvalCase }>, deployment: Pick<ModelDeployment, "repo" | "port" | "host">, options: DataRunOptions = {}): Promise<DataRunResult> {
  const call = options.fetch ?? localFetch;
  const now = options.now ?? Date.now;
  const url = `${modelApiBase(deployment)}/chat/completions`;
  const timeoutMs = options.caseTimeoutMs ?? CASE_TIMEOUT_MS;
  const results: CaseResult[] = new Array(cases.length);
  const skipped: Record<string, number> = {};
  let timedOut = false;
  let next = 0;
  const one = async (index: number): Promise<CaseResult> => {
    const { source, item } = cases[index]!;
    const base = { source, ...(item.metadata.id !== undefined ? { id: String(item.metadata.id) } : {}), input: item.input, ...(item.expected ? { expected: item.expected } : {}) };
    const checkable = !!item.expected?.length || (item.assertions ?? []).some((assertion) => checkAssertion(assertion, "") !== undefined);
    const failure = (error: string): CaseResult => ({ ...base, error, status: checkable ? "fail" : "no-check", ...(checkable ? { reason: error } : {}) });
    if (options.deadline !== undefined && now() >= options.deadline) { timedOut = true; return failure("not run: the time limit was reached"); }
    const messages = typeof item.input === "string" ? [{ role: "user", content: item.input }] : item.input;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let output: string;
    let note: string | undefined;
    try {
      const response = await call(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer dl-local" }, signal: controller.signal,
        body: JSON.stringify({ model: deployment.repo, messages, temperature: 0, max_tokens: options.maxTokens ?? DATA_MAX_TOKENS, ...NO_THINKING }) });
      const text = await response.text();
      if (!response.ok) return failure(`HTTP ${response.status}: ${clip(text, 80)}`);
      const choice = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; finish_reason?: string | null }> }).choices?.[0];
      output = answerText(choice?.message?.content);
      if (!output && hasReasoning(choice?.message)) note = noTextReason(choice?.message, choice?.finish_reason).reason;
    } catch (error) {
      return failure(controller.signal.aborted ? `no answer in ${Math.round(timeoutMs / 1000)} s` : error instanceof SyntaxError ? "the reply is not JSON" : connectionError(error));
    } finally {
      clearTimeout(timer);
    }
    const scored = scoreCase(item, output);
    for (const type of scored.skipped) skipped[type] = (skipped[type] ?? 0) + 1;
    return { ...base, output, ...(note ? { error: note } : {}), status: scored.status, ...(scored.reason ? { reason: note && scored.status === "fail" ? `${note}; ${scored.reason}` : scored.reason } : {}) };
  };
  const worker = async () => { while (next < cases.length) { const index = next++; results[index] = await one(index); } };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? DATA_CONCURRENCY, cases.length) }, worker));
  const checked = results.filter((result) => result.status !== "no-check").length;
  const passed = results.filter((result) => result.status === "pass").length;
  return { cases: results, checked, passed, noCheck: results.length - checked, errors: results.filter((result) => result.error && result.output === undefined).length, skipped, timedOut,
    ...(checked ? { score: passed / checked } : {}) };
}

/** "41 of 44 passed · 3 with no check · 2 errors · llm-rubric ×6 skipped (not supported)". */
export function dataRunSummary(run: DataRunResult): string {
  const parts = [run.checked ? `${run.passed} of ${run.checked} passed` : "nothing to check (no expected answers or supported assertions)"];
  if (run.checked && run.noCheck) parts.push(`${run.noCheck} with no check`);
  if (run.errors) parts.push(`${run.errors} ${run.errors === 1 ? "error" : "errors"}`);
  const skipped = Object.entries(run.skipped).map(([type, count]) => `${type} ×${count}`);
  if (skipped.length) parts.push(`${skipped.join(", ")} skipped (not supported)`);
  if (run.timedOut) parts.push("stopped at the time limit");
  return parts.join(" · ");
}

/** The first few failing cases, one line each. */
export function failureLines(run: DataRunResult, max = 5): string[] {
  const failed = run.cases.filter((result) => result.status === "fail");
  const lines = failed.slice(0, max).map((result) => clip(`${result.source}${result.id && !result.source.includes(result.id) ? ` (${result.id})` : ""}: ${result.reason ?? "failed"}`, 140));
  if (failed.length > max) lines.push(`and ${failed.length - max} more in the results file`);
  return lines;
}
