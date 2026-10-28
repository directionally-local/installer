/**
 * What people see while the installer works. On a terminal: a live checklist in
 * Camouflage's visual language (✓ done, ✗ failed, ○ pending, a spinner and timer on the
 * active step), redrawn in place in normal scrollback so the final link and command stay
 * on screen to copy. Without a terminal (CI, logs, unattended installs): one plain line
 * per event. Other tools' output never reaches the screen; it goes to the install log.
 */

export interface SummaryItem {
  /** What to do, e.g. "Open once to approve laptops". */
  label: string;
  /** The thing to copy: a link or a command. */
  value: string;
}

export interface ReadyExtra {
  /** A few lines saying what this is, under the headline. */
  about?: string[];
  /** A last line, e.g. how to see this again. */
  footer?: string;
}

export interface Ui {
  readonly interactive: boolean;
  title(text: string): void;
  /** A finished line outside the checklist (e.g. the machine check before the questions). */
  line(status: "done" | "failed" | "info", label: string, detail?: string): void;
  /** Shows the remaining steps as pending; the checklist is redrawn as they progress. */
  plan(steps: Array<{ id: string; label: string }>): void;
  start(id: string, detail?: string): void;
  done(id: string, detail?: string): void;
  fail(id: string, message: string): void;
  /** Questions: introduce them, then confirm or reject each answer in place of its prompt. */
  questions(intro: string): void;
  answered(label: string, detail?: string): void;
  rejected(message: string): void;
  /** Styles a prompt: label, a dim hint, and an input marker. */
  prompt(label: string, hint?: string): string;
  ready(headline: string, items: SummaryItem[], extra?: ReadyExtra): void;
  /** A problem worth reading after the checklist (not a failure). */
  warn(text: string): void;
  finish(): void;
}

type Status = "pending" | "active" | "done" | "failed";
interface Step { id: string; label: string; status: Status; detail?: string; startedAt?: number }

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPH: Record<Status | "info", string> = { pending: "○", active: "", done: "✓", failed: "✗", info: "·" };
const LABEL_WIDTH = 33;

/** ANSI styles, or none under NO_COLOR / TERM=dumb. */
export function palette(enabled: boolean) {
  const wrap = (open: string, close: string) => (text: string) => enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    green: wrap("32", "39"),
    red: wrap("31", "39"),
    yellow: wrap("33", "39"),
    cyan: wrap("36", "39"),
  };
}

export class TerminalUi implements Ui {
  readonly interactive = true;
  private steps: Step[] = [];
  private rendered = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly warnings: string[] = [];
  private readonly c: ReturnType<typeof palette>;

  constructor(
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
    private readonly columns: () => number = () => process.stdout.columns || 80,
    color = !process.env.NO_COLOR && process.env.TERM !== "dumb",
  ) {
    this.c = palette(color);
  }

  title(text: string): void {
    this.write(`\n  ${this.c.bold(text)}\n\n`);
  }

  line(status: "done" | "failed" | "info", label: string, detail?: string): void {
    this.write(`${this.fit(this.row(status, label, detail))}\n`);
  }

  plan(steps: Array<{ id: string; label: string }>): void {
    this.steps = steps.map((step) => ({ ...step, status: "pending" }));
    this.render();
  }

  start(id: string, detail?: string): void {
    const step = this.step(id);
    step.status = "active";
    step.startedAt = Date.now();
    if (detail !== undefined) step.detail = detail;
    // Animate only while something is running; unref so a finished run exits.
    this.timer ??= setInterval(() => { this.frame++; this.render(); }, 80);
    this.timer.unref?.();
    this.render();
  }

  done(id: string, detail?: string): void {
    const step = this.step(id);
    step.status = "done";
    step.detail = detail;
    this.settle();
  }

  fail(id: string, message: string): void {
    const step = this.step(id);
    step.status = "failed";
    step.detail = message.split("\n")[0];
    this.settle();
  }

  questions(intro: string): void {
    this.write(`\n  ${this.c.dim(intro)}\n\n`);
  }

  prompt(label: string, hint?: string): string {
    return `  ${this.c.bold(label)}${hint ? `  ${this.c.dim(hint)}` : ""}\n  ${this.c.cyan("›")} `;
  }

  answered(label: string, detail?: string): void {
    // Replace the two prompt lines with a confirmation.
    this.write(`\x1b[2F\x1b[J${this.fit(this.row("done", label, detail))}\n`);
  }

  rejected(message: string): void {
    this.write(`\x1b[2F\x1b[J  ${this.c.yellow("!")} ${message}\n`);
  }

  ready(headline: string, items: SummaryItem[], extra: ReadyExtra = {}): void {
    this.stop();
    this.write(`\n  ${this.c.green("✓")} ${this.c.bold(headline)}\n`);
    if (extra.about) this.write(`\n${extra.about.map((line) => `  ${line}`).join("\n")}\n`);
    items.forEach((item, index) => {
      // Values are never truncated: they're meant to be copied. Each line is its own command.
      const value = item.value.split("\n").map((line) => `     ${this.c.bold(line)}`).join("\n");
      this.write(`\n  ${this.c.cyan(String(index + 1))}  ${item.label}\n${value}\n`);
    });
    if (extra.footer) this.write(`\n  ${this.c.dim(extra.footer)}\n`);
    this.write("\n");
    this.flushWarnings();
  }

  warn(text: string): void {
    this.warnings.push(text);
  }

  finish(): void {
    this.stop();
    this.flushWarnings();
  }

  private settle(): void {
    if (!this.steps.some((step) => step.status === "active")) this.stop();
    this.render();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private flushWarnings(): void {
    for (const text of this.warnings.splice(0)) this.write(`  ${this.c.yellow("!")} ${text}\n`);
  }

  private render(): void {
    const lines = this.steps.map((step) => this.fit(this.row(step.status, step.label, this.detailFor(step))));
    // Back to the top of the checklist and redraw it; lines never wrap, so the count holds.
    const rewind = this.rendered > 0 ? `\x1b[${this.rendered}F` : "";
    this.write(`${rewind}${lines.map((line) => `\x1b[2K${line}\n`).join("")}`);
    this.rendered = lines.length;
  }

  private detailFor(step: Step): string | undefined {
    if (step.status !== "active") return step.detail;
    const seconds = Math.floor((Date.now() - (step.startedAt ?? Date.now())) / 1000);
    const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return step.detail ? `${step.detail} · ${elapsed}` : elapsed;
  }

  private row(status: Status | "info", label: string, detail?: string): Segment[] {
    const glyph = status === "active" ? this.c.cyan(SPINNER[this.frame % SPINNER.length]!) :
      status === "done" ? this.c.green(GLYPH.done) :
      status === "failed" ? this.c.red(GLYPH.failed) :
      this.c.dim(GLYPH[status]);
    const text = status === "pending" ? this.c.dim(label) : status === "failed" ? this.c.red(label) : label;
    const segments: Segment[] = [{ plain: "  ", styled: "  " }, { plain: "x", styled: glyph }, { plain: " ", styled: " " }, { plain: label, styled: text }];
    if (detail) {
      const pad = " ".repeat(Math.max(2, LABEL_WIDTH - label.length));
      segments.push({ plain: pad, styled: pad }, { plain: detail, styled: status === "failed" ? this.c.red(detail) : this.c.dim(detail) });
    }
    return segments;
  }

  /** Joins styled segments, truncated by their visible width so a line never wraps. */
  private fit(segments: Segment[]): string {
    let room = Math.max(10, this.columns() - 1);
    let out = "";
    for (const segment of segments) {
      if (room <= 0) break;
      if (segment.plain.length <= room) {
        out += segment.styled;
        room -= segment.plain.length;
      } else {
        out += this.c.dim(`${segment.plain.slice(0, Math.max(0, room - 1))}…`);
        room = 0;
      }
    }
    return out;
  }

  private step(id: string): Step {
    const step = this.steps.find((entry) => entry.id === id);
    if (!step) throw new Error(`unknown step ${id}`);
    return step;
  }
}

interface Segment { plain: string; styled: string }

/** Logs, CI, and unattended installs: one plain line per event, no escape codes. */
export class PlainUi implements Ui {
  readonly interactive = false;
  private labels = new Map<string, string>();

  constructor(private readonly write: (text: string) => void = (text) => process.stdout.write(text)) {}

  title(text: string): void { this.write(`${text}\n`); }
  line(status: "done" | "failed" | "info", label: string, detail?: string): void {
    this.write(`${status === "done" ? "ok" : status === "failed" ? "FAILED" : "--"} ${label}${detail ? `: ${detail}` : ""}\n`);
  }
  plan(steps: Array<{ id: string; label: string }>): void { this.labels = new Map(steps.map((step) => [step.id, step.label])); }
  start(id: string, detail?: string): void { this.write(`.. ${this.labels.get(id) ?? id}${detail ? `: ${detail}` : ""}\n`); }
  done(id: string, detail?: string): void { this.write(`ok ${this.labels.get(id) ?? id}${detail ? `: ${detail}` : ""}\n`); }
  fail(id: string, message: string): void { this.write(`FAILED ${this.labels.get(id) ?? id}: ${message}\n`); }
  questions(intro: string): void { this.write(`${intro}\n`); }
  prompt(label: string, hint?: string): string { return `${label}${hint ? ` (${hint})` : ""}: `; }
  answered(label: string, detail?: string): void { this.write(`ok ${label}${detail ? `: ${detail}` : ""}\n`); }
  rejected(message: string): void { this.write(`!! ${message}\n`); }
  ready(headline: string, items: SummaryItem[], extra: ReadyExtra = {}): void {
    this.write(`\n${headline}\n`);
    if (extra.about) this.write(`${extra.about.join(" ")}\n`);
    for (const item of items) this.write(`  ${item.label}: ${item.value.split("\n").join(" ; ")}\n`);
    if (extra.footer) this.write(`${extra.footer}\n`);
  }
  warn(text: string): void { this.write(`!! ${text}\n`); }
  finish(): void {}
}

/** One progress event of `dl up --events json`; see JsonUi. */
export type JsonEvent =
  | { event: "title"; text: string }
  | { event: "line"; status: "done" | "failed" | "info"; label: string; detail?: string }
  | { event: "plan"; steps: Array<{ id: string; label: string }> }
  | { event: "start"; id: string; detail?: string }
  | { event: "done"; id: string; detail?: string }
  | { event: "fail"; id: string; message: string }
  | { event: "warn"; text: string }
  | { event: "questions"; text: string }
  | { event: "answered"; label: string; detail?: string }
  | { event: "ready"; headline: string; items: SummaryItem[]; about?: string[]; footer?: string }
  | { event: "error"; message: string };

/**
 * For the laptop that runs `dl up` over SSH and draws the progress itself: one JSON object
 * per line (NDJSON) on stdout, nothing else there. Nothing is asked in this mode, so a
 * rejected answer is only a warning, and a prompt is never shown.
 */
export class JsonUi implements Ui {
  readonly interactive = false;

  constructor(private readonly write: (text: string) => void = (text) => process.stdout.write(text)) {}

  title(text: string): void { this.emit({ event: "title", text }); }
  line(status: "done" | "failed" | "info", label: string, detail?: string): void { this.emit({ event: "line", status, label, detail }); }
  plan(steps: Array<{ id: string; label: string }>): void { this.emit({ event: "plan", steps: steps.map(({ id, label }) => ({ id, label })) }); }
  start(id: string, detail?: string): void { this.emit({ event: "start", id, detail }); }
  done(id: string, detail?: string): void { this.emit({ event: "done", id, detail }); }
  fail(id: string, message: string): void { this.emit({ event: "fail", id, message }); }
  questions(intro: string): void { this.emit({ event: "questions", text: intro }); }
  prompt(label: string): string { return label; }
  answered(label: string, detail?: string): void { this.emit({ event: "answered", label, detail }); }
  rejected(message: string): void { this.emit({ event: "warn", text: message }); }
  ready(headline: string, items: SummaryItem[], extra: ReadyExtra = {}): void {
    this.emit({ event: "ready", headline, items: items.map(({ label, value }) => ({ label, value })), about: extra.about, footer: extra.footer });
  }
  warn(text: string): void { this.emit({ event: "warn", text }); }
  /** The last event of a failed run (not part of Ui: the CLI reports failures, not `up`). */
  error(message: string): void { this.emit({ event: "error", message }); }
  finish(): void {}

  private emit(event: JsonEvent): void {
    // JSON.stringify drops undefined fields and escapes newlines, so each event is one line.
    this.write(`${JSON.stringify(event)}\n`);
  }
}

/** Records events for tests. */
export class RecordingUi implements Ui {
  readonly interactive = false;
  readonly events: string[] = [];
  title(text: string): void { this.events.push(`title ${text}`); }
  line(status: string, label: string, detail?: string): void { this.events.push(`line ${status} ${label}${detail ? ` | ${detail}` : ""}`); }
  plan(steps: Array<{ id: string; label: string }>): void { this.events.push(`plan ${steps.map((step) => step.id).join(",")}`); }
  start(id: string): void { this.events.push(`start ${id}`); }
  done(id: string, detail?: string): void { this.events.push(`done ${id}${detail ? ` | ${detail}` : ""}`); }
  fail(id: string, message: string): void { this.events.push(`fail ${id} | ${message}`); }
  questions(intro: string): void { this.events.push(`questions ${intro}`); }
  prompt(label: string): string { return label; }
  answered(label: string, detail?: string): void { this.events.push(`answered ${label}${detail ? ` | ${detail}` : ""}`); }
  rejected(message: string): void { this.events.push(`rejected ${message}`); }
  ready(headline: string, items: SummaryItem[], extra: ReadyExtra = {}): void {
    this.events.push(`ready ${headline}`, ...(extra.about ?? []).map((line) => `about ${line}`), ...items.map((item) => `item ${item.label} | ${item.value}`), ...(extra.footer ? [`footer ${extra.footer}`] : []));
  }
  warn(text: string): void { this.events.push(`warn ${text}`); }
  finish(): void {}
}
