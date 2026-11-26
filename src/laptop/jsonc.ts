/**
 * Small, careful edits to a JSON-with-comments file (Zed's settings.json):
 * set or remove one member of one top-level object, and leave every other
 * byte (comments, order, formatting, trailing commas) as it was.
 *
 * It reads the file with a scanner that understands strings, `//` and
 * `/* *\/` comments and trailing commas, records where each member's key and
 * value are, and splices text in or out. A file it can't read is never
 * rewritten: the caller gets an error and the file stays as it was.
 */

export class JsoncError extends Error {}

interface Member {
  key: string;
  /** Offset of the key's opening quote. */
  start: number;
  valueStart: number;
  /** Offset just past the value. */
  valueEnd: number;
}

interface ObjectSpan {
  /** Offset of `{`. */
  open: number;
  /** Offset of `}`. */
  close: number;
  members: Member[];
}

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  skip(): void {
    const t = this.text;
    for (;;) {
      const c = t[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") {
        this.pos++;
      } else if (c === "/" && t[this.pos + 1] === "/") {
        const end = t.indexOf("\n", this.pos);
        this.pos = end === -1 ? t.length : end + 1;
      } else if (c === "/" && t[this.pos + 1] === "*") {
        const end = t.indexOf("*/", this.pos + 2);
        if (end === -1) throw new JsoncError("an unterminated /* comment");
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  peek(): string | undefined {
    this.skip();
    return this.text[this.pos];
  }

  expect(c: string): void {
    if (this.peek() !== c) throw new JsoncError(`expected "${c}" at offset ${this.pos}`);
    this.pos++;
  }

  string(): string {
    this.skip();
    const start = this.pos;
    if (this.text[start] !== '"') throw new JsoncError(`expected a string at offset ${start}`);
    let i = start + 1;
    while (i < this.text.length) {
      const c = this.text[i];
      if (c === "\\") i += 2;
      else if (c === '"') break;
      else i++;
    }
    if (i >= this.text.length) throw new JsoncError("an unterminated string");
    this.pos = i + 1;
    return JSON.parse(this.text.slice(start, this.pos)) as string;
  }

  /** Skip one value; returns its span. Objects are read member by member. */
  value(): { start: number; end: number; object?: ObjectSpan } {
    const c = this.peek();
    const start = this.pos;
    if (c === "{") {
      const object = this.object();
      return { start, end: this.pos, object };
    }
    if (c === "[") {
      this.pos++;
      while (this.peek() !== "]") {
        this.value();
        if (this.peek() === ",") this.pos++;
        else if (this.peek() !== "]") throw new JsoncError(`expected "," or "]" at offset ${this.pos}`);
      }
      this.pos++;
      return { start, end: this.pos };
    }
    if (c === '"') {
      this.string();
      return { start, end: this.pos };
    }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
    if (!m) throw new JsoncError(`unexpected text at offset ${this.pos}`);
    this.pos += m[0].length;
    return { start, end: this.pos };
  }

  object(): ObjectSpan {
    const open = this.pos;
    this.expect("{");
    const members: Member[] = [];
    while (this.peek() !== "}") {
      if (this.peek() === undefined) throw new JsoncError("an unterminated object");
      this.skip();
      const start = this.pos;
      const key = this.string();
      this.expect(":");
      this.skip();
      const v = this.value();
      members.push({ key, start, valueStart: v.start, valueEnd: v.end });
      if (this.peek() === ",") this.pos++;
      else if (this.peek() !== "}") throw new JsoncError(`expected "," or "}" at offset ${this.pos}`);
    }
    const close = this.pos;
    this.pos++;
    return { open, close, members };
  }
}

function parseTop(text: string): ObjectSpan {
  const s = new Scanner(text);
  const top = s.object();
  if (s.peek() !== undefined) throw new JsoncError(`unexpected text after the settings object at offset ${s.pos}`);
  return top;
}

function objectAt(text: string, member: Member): ObjectSpan | undefined {
  const s = new Scanner(text);
  s.pos = member.valueStart;
  return s.peek() === "{" ? s.object() : undefined;
}

/** The indentation of the line holding `offset`. */
function indentOf(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** `value` as JSON, its lines after the first indented by `indent`. */
function render(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/** Insert `"key": value` as the first member of `obj`. */
function insertFirst(text: string, obj: ObjectSpan, key: string, value: unknown): string {
  const outer = indentOf(text, obj.open);
  const inner = obj.members.length > 0 ? indentOf(text, obj.members[0]!.start) || `${outer}  ` : `${outer}  `;
  const entry = `${JSON.stringify(key)}: ${render(value, inner)}`;
  if (obj.members.length === 0) return `${text.slice(0, obj.open + 1)}\n${inner}${entry}\n${outer}${text.slice(obj.close)}`;
  return `${text.slice(0, obj.open + 1)}\n${inner}${entry},${text.slice(obj.open + 1)}`;
}

/** The parsed value of `objectKey.memberKey`, or undefined. Throws JsoncError on a file it can't read. */
export function readMember(text: string, objectKey: string, memberKey: string): unknown {
  if (!text.trim()) return undefined;
  const top = parseTop(text);
  const outer = top.members.find((m) => m.key === objectKey);
  if (!outer) return undefined;
  const obj = objectAt(text, outer);
  const member = obj?.members.find((m) => m.key === memberKey);
  if (!member) return undefined;
  return JSON.parse(stripComments(text.slice(member.valueStart, member.valueEnd)));
}

/** Set `objectKey.memberKey` to `value` (adding the object if needed). */
export function setMember(text: string, objectKey: string, memberKey: string, value: unknown): string {
  if (!text.trim()) return `${JSON.stringify({ [objectKey]: { [memberKey]: value } }, null, 2)}\n`;
  const top = parseTop(text);
  const outer = top.members.find((m) => m.key === objectKey);
  if (!outer) return insertFirst(text, top, objectKey, { [memberKey]: value });
  const obj = objectAt(text, outer);
  if (!obj) throw new JsoncError(`"${objectKey}" isn't an object`);
  const existing = obj.members.find((m) => m.key === memberKey);
  if (!existing) return insertFirst(text, obj, memberKey, value);
  return `${text.slice(0, existing.valueStart)}${render(value, indentOf(text, existing.start))}${text.slice(existing.valueEnd)}`;
}

/** Remove `objectKey.memberKey`; the text unchanged when it isn't there. */
export function removeMember(text: string, objectKey: string, memberKey: string): string {
  if (!text.trim()) return text;
  const top = parseTop(text);
  const outer = top.members.find((m) => m.key === objectKey);
  if (!outer) return text;
  const obj = objectAt(text, outer);
  const index = obj?.members.findIndex((m) => m.key === memberKey) ?? -1;
  if (!obj || index === -1) return text;
  const member = obj.members[index]!;
  // From the end of whatever comes before (the `{` or the previous member's comma) to the end of
  // this member and its own comma, so neither a blank line nor a dangling comma is left.
  const s = new Scanner(text);
  s.pos = member.valueEnd;
  const hasComma = s.peek() === ",";
  const end = hasComma ? s.pos + 1 : member.valueEnd;
  let start = text.lastIndexOf("\n", member.start - 1);
  if (start < obj.open) start = obj.open + 1;
  if (!hasComma && index > 0) {
    // The last member: drop the previous member's comma instead.
    const prev = obj.members[index - 1]!;
    const p = new Scanner(text);
    p.pos = prev.valueEnd;
    if (p.peek() === ",") return `${text.slice(0, p.pos)}${text.slice(end)}`;
  }
  return `${text.slice(0, start)}${text.slice(end)}`;
}

function stripComments(json: string): string {
  let out = "";
  let i = 0;
  while (i < json.length) {
    const c = json[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && json[i + 1] === "/") {
      const end = json.indexOf("\n", i);
      i = end === -1 ? json.length : end;
    } else if (c === "/" && json[i + 1] === "*") {
      const end = json.indexOf("*/", i + 2);
      i = end === -1 ? json.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse a JSON-with-comments text (comments and trailing commas allowed). */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripComments(text));
}
