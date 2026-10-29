import { openSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { palette } from "./ui.js";

export interface SelectOption {
  value: string;
  label: string;
  /** A dim note after the label. */
  detail?: string;
  /**
   * Picking this option asks for text instead (e.g. "Another server" → user@host).
   * `prompt` is the styled prompt for the numbered fallback (ui.prompt(…)); `placeholder`
   * is the dim hint shown in the empty input on a terminal.
   */
  input?: { prompt: string; placeholder: string };
}

export interface SelectResult {
  value: string;
  /** What was typed, when the picked option takes input. */
  text?: string;
}

/** Thrown when someone presses Esc or Ctrl-C at a question; the terminal is already restored. */
export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "PromptCancelled";
  }
}

/** Questions `up` asks. Tests and unattended installs answer them without a terminal. */
export interface Prompter {
  choose(question: string, options: Array<{ value: string; label: string }>, fallback: string): Promise<string>;
  /**
   * One of a few options: an arrow-key list on a terminal, a numbered prompt otherwise.
   * `question` is ui.prompt(label). It ends like an answered text prompt (the question line
   * and `› choice`), so ui.answered() replaces it with the ✓ line.
   */
  select(question: string, options: SelectOption[], initial?: number): Promise<SelectResult>;
  /** Hidden input for keys and tokens. */
  secret(question: string): Promise<string>;
  text(question: string): Promise<string>;
}

/** The terminal a prompt talks to: /dev/tty in real use, a fake in tests. */
export interface PromptTerminal {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: NodeJS.WritableStream & { columns?: number };
  close(): void;
}

function openDevTty(): PromptTerminal {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("No terminal to ask on; pass the answers as environment variables (see `dl --help`).");
  }
  const input = new ReadStream(fd);
  const output = new WriteStream(fd);
  return {
    input,
    output,
    close: () => {
      input.destroy();
      output.destroy();
      try { closeSync(fd); } catch { /* already closed with the streams */ }
    },
  };
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Reads from /dev/tty, so prompts work under `curl … | sh` where stdin is the script.
 * Without a terminal every question fails with the env var that answers it.
 */
export class TtyPrompter implements Prompter {
  private readonly open: () => PromptTerminal;
  private readonly color: boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { open?: () => PromptTerminal; color?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    this.open = options.open ?? openDevTty;
    this.env = options.env ?? process.env;
    this.color = options.color ?? (!this.env.NO_COLOR && this.env.TERM !== "dumb");
  }

  async choose(question: string, options: Array<{ value: string; label: string }>, fallback: string): Promise<string> {
    const lines = options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n");
    const answer = (await this.ask(`${question}\n${lines}\nChoice [1]: `, false)).trim();
    if (!answer) return options[0]?.value ?? fallback;
    const index = Number(answer) - 1;
    return options[index]?.value ?? options.find((option) => option.value === answer)?.value ?? fallback;
  }

  async select(question: string, options: SelectOption[], initial = 0): Promise<SelectResult> {
    if (options.length === 0) throw new Error("select() needs at least one option");
    const start = Math.min(Math.max(0, initial), options.length - 1);
    const terminal = this.open();
    const raw = typeof terminal.input.setRawMode === "function" && terminal.input.isTTY === true && this.env.TERM !== "dumb";
    if (!raw) {
      terminal.close();
      return this.numbered(question, options, start);
    }
    return new ArrowSelect(terminal, question, options, start, this.color).run();
  }

  secret(question: string): Promise<string> {
    return this.ask(question, true);
  }

  text(question: string): Promise<string> {
    return this.ask(question, false);
  }

  /** The plain fallback: a numbered list, then a typed choice (Enter for the preselected one). */
  private async numbered(question: string, options: SelectOption[], start: number): Promise<SelectResult> {
    const c = palette(this.color);
    const width = Math.max(...options.map((option) => option.label.length)) + 2;
    const list = options.map((option, index) => `  ${c.cyan(String(index + 1))}  ${option.detail ? `${option.label.padEnd(width)} ${c.dim(option.detail)}` : option.label}`).join("\n");
    const typed = options.find((option) => option.input);
    const range = options.length === 2 ? "1 or 2" : `1-${options.length}`;
    const hint = `${range}${typed ? `, or ${typed.input!.placeholder.split(",")[0]}` : ""} · Enter for ${start + 1}`;
    const split = question.lastIndexOf("\n");
    const styled = split >= 0 ? `${question.slice(0, split)}  ${c.dim(hint)}${question.slice(split)}` : question;
    for (let attempt = 1; ; attempt++) {
      const answer = (await this.ask(`${attempt === 1 ? `${list}\n\n` : ""}${styled}`, false)).trim();
      const index = answer === "" ? start : /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      const option = options[index];
      if (option?.input) return { value: option.value, text: (await this.ask(option.input.prompt, false)).trim() };
      if (option) return { value: option.value };
      if (typed && answer) return { value: typed.value, text: answer };
      if (attempt >= 3) throw new Error(`Pick one of ${range}`);
    }
  }

  private ask(question: string, hidden: boolean): Promise<string> {
    const { input, output, close } = this.open();
    // A styled prompt is "label line\n› ": print the label line ourselves and give readline
    // only the last line, so its redraws (and the hidden-input filter) stay on one line.
    const split = question.lastIndexOf("\n");
    const head = split >= 0 ? question.slice(0, split + 1) : "";
    const line = split >= 0 ? question.slice(split + 1) : question;
    if (head) output.write(head);
    return new Promise((resolve) => {
      const rl = createInterface({ input, output, terminal: input.isTTY === true });
      if (hidden) {
        // Echo nothing while the secret is typed.
        (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
          if (text.includes(line)) output.write(text);
        };
      }
      rl.question(line, (answer) => {
        if (hidden) output.write("\n");
        rl.close();
        close();
        resolve(answer.trim());
      });
    });
  }
}

export type Key = "up" | "down" | "enter" | "escape" | "cancel" | "backspace" | "clear" | { text: string };

/** Splits a chunk of terminal input into keys (one chunk can hold several, e.g. a paste). */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let text = "";
  const push = (key: Key) => {
    if (text) keys.push({ text });
    text = "";
    keys.push(key);
  };
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\x1b") {
      const next = chunk[i + 1];
      if (next === "[" || next === "O") {
        // CSI / SS3: skip the parameters up to the final byte.
        let end = i + 2;
        while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end]!)) end++;
        const final = chunk[end];
        if (final === "A") push("up");
        else if (final === "B") push("down");
        i = end;
      } else {
        push("escape");
      }
    } else if (ch === "\r" || ch === "\n") {
      push("enter");
    } else if (ch === "\x03" || ch === "\x04") {
      push("cancel");
    } else if (ch === "\x7f" || ch === "\b") {
      push("backspace");
    } else if (ch === "\x15") {
      push("clear");
    } else if (ch >= " ") {
      text += ch;
    }
  }
  if (text) keys.push({ text });
  return keys;
}

/**
 * The arrow-key list, drawn inline under the question in normal scrollback: ↑/↓ or j/k move
 * the `›` cursor, a digit jumps, Enter picks, Esc or Ctrl-C cancels. It redraws only its own
 * lines and hides the cursor meanwhile; raw mode and the cursor come back on every way out,
 * including a crash or a SIGINT/SIGTERM from elsewhere.
 */
class ArrowSelect {
  private cursor: number;
  private typing = false;
  private text = "";
  private digits = "";
  private drawn = 0;
  private readonly head: string;
  private readonly marker: string;
  private readonly caret: string;
  private readonly c: ReturnType<typeof palette>;

  constructor(
    private readonly terminal: PromptTerminal,
    question: string,
    private readonly options: SelectOption[],
    start: number,
    color: boolean,
  ) {
    this.c = palette(color);
    this.cursor = start;
    this.caret = color ? "\x1b[7m \x1b[27m" : "▏";
    const split = question.lastIndexOf("\n");
    this.head = split >= 0 ? question.slice(0, split) : question.trimEnd();
    this.marker = split >= 0 ? question.slice(split + 1) : `${this.c.cyan("›")} `;
  }

  run(): Promise<SelectResult> {
    const { input, output } = this.terminal;
    return new Promise((resolve, reject) => {
      let finished = false;
      const restore = () => {
        input.setRawMode?.(false);
        output.write(SHOW_CURSOR);
      };
      const onExit = () => restore();
      const onSignal = () => { restore(); process.exit(130); };
      const end = (outcome: () => void) => {
        if (finished) return;
        finished = true;
        input.off("data", onData);
        process.off("exit", onExit);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        restore();
        this.terminal.close();
        outcome();
      };
      const onData = (chunk: Buffer | string) => {
        try {
          for (const key of parseKeys(typeof chunk === "string" ? chunk : chunk.toString("utf8"))) {
            const result = this.handle(key);
            if (result === "cancel") {
              this.erase(true);
              end(() => reject(new PromptCancelled()));
              return;
            }
            if (result) {
              // Leave what an answered text prompt leaves: the question and `› choice`.
              this.erase(false);
              output.write(`${this.marker}${result.text ?? this.options.find((option) => option.value === result.value)!.label}\n`);
              end(() => resolve(result));
              return;
            }
          }
          this.draw();
        } catch (error) {
          end(() => reject(error));
        }
      };
      process.once("exit", onExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      input.setRawMode!(true);
      input.on("data", onData);
      input.resume();
      output.write(`${HIDE_CURSOR}${this.fit(this.head, this.c.dim("  ↑/↓ to move · Enter to pick"))}\n`);
      this.draw();
    });
  }

  /** Applies a key: a result when something was picked, "cancel" to stop, else nothing (redraw). */
  private handle(key: Key): SelectResult | "cancel" | undefined {
    if (key === "cancel") return "cancel";
    if (this.typing) {
      if (key === "escape") { this.typing = false; this.text = ""; }
      else if (key === "enter") return this.text.trim() ? { value: this.options[this.cursor]!.value, text: this.text.trim() } : undefined;
      else if (key === "backspace") this.text = this.text.slice(0, -1);
      else if (key === "clear") this.text = "";
      else if (typeof key === "object") this.text += key.text;
      return undefined;
    }
    if (key === "escape") return "cancel";
    if (key === "up") this.move(-1);
    else if (key === "down") this.move(1);
    else if (key === "enter") {
      const option = this.options[this.cursor]!;
      if (!option.input) return { value: option.value };
      this.typing = true;
    } else if (typeof key === "object") {
      for (const ch of key.text) {
        if (ch === "k") this.move(-1);
        else if (ch === "j") this.move(1);
        else if (/\d/.test(ch)) this.jump(ch);
      }
    }
    return undefined;
  }

  private move(by: number): void {
    this.digits = "";
    this.cursor = (this.cursor + by + this.options.length) % this.options.length;
  }

  /** A digit jumps to that option; with 10 or more, a second digit right after makes 10+. */
  private jump(digit: string): void {
    const combined = Number(this.digits + digit) - 1;
    if (this.digits && combined < this.options.length) {
      this.cursor = combined;
      this.digits = "";
      return;
    }
    const single = Number(digit) - 1;
    if (single >= 0 && single < this.options.length) this.cursor = single;
    this.digits = this.options.length >= 10 && single >= 0 ? digit : "";
  }

  private lines(): string[] {
    if (this.typing) {
      const option = this.options[this.cursor]!;
      const placeholder = this.text ? "" : this.c.dim(option.input!.placeholder);
      // The real cursor stays hidden (it sits below the list); draw one where typing goes.
      return [this.c.dim(`  ${option.label} · Esc to go back`), `${this.marker}${this.text}${this.caret}${placeholder}`];
    }
    const width = Math.max(...this.options.map((option) => option.label.length)) + 2;
    return this.options.map((option, index) => {
      const selected = index === this.cursor;
      const label = option.detail ? option.label.padEnd(width) : option.label;
      const line = `  ${selected ? this.c.cyan("›") : " "} ${selected ? this.c.bold(label) : label}`;
      return this.fit(line, option.detail ? this.c.dim(option.detail) : "");
    });
  }

  /** Redraws the lines under the question in place; lines never wrap, so the count holds. */
  private draw(): void {
    const lines = this.lines();
    const rewind = this.drawn > 0 ? `\x1b[${this.drawn}F` : "";
    // When there are fewer lines than last time (typing mode), clear what's left below.
    const stale = this.drawn > lines.length ? "\x1b[J" : "";
    this.terminal.output.write(`${rewind}${lines.map((line) => `\x1b[2K${line}\n`).join("")}${stale}`);
    this.drawn = lines.length;
  }

  /** Erases the list (and, when cancelling, the question too). */
  private erase(all: boolean): void {
    const up = this.drawn + (all ? 1 : 0);
    this.terminal.output.write(`${up > 0 ? `\x1b[${up}F` : ""}\x1b[J`);
    this.drawn = 0;
  }

  /** `styled` plus a dim tail, the tail cut so the line fits the terminal's width. */
  private fit(styled: string, tail: string): string {
    const columns = this.terminal.output.columns || 80;
    const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    const room = columns - 1 - visible(styled).length;
    const plainTail = visible(tail);
    if (plainTail.length <= room) return `${styled}${tail}`;
    if (room <= 1) return styled;
    return `${styled}${this.c.dim(`${plainTail.slice(0, room - 1)}…`)}`;
  }
}

/** Answers from a map (tests); a missing answer is a test bug, so it throws. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];

  constructor(private readonly answers: Record<string, string>) {}

  async choose(question: string): Promise<string> {
    return this.answer(question);
  }

  /**
   * An answer is a number (1-based), an option's value or label, or "" for the preselected
   * one. Picking an option that takes input then asks its prompt; other text goes to it directly.
   */
  async select(question: string, options: SelectOption[], initial = 0): Promise<SelectResult> {
    const answer = this.answer(question).trim();
    const index = answer === "" ? initial : /^\d+$/.test(answer) ? Number(answer) - 1 : options.findIndex((option) => option.value === answer || option.label === answer);
    const option = options[index];
    if (option?.input) return { value: option.value, text: this.answer(option.input.prompt).trim() };
    if (option) return { value: option.value };
    const typed = options.find((entry) => entry.input);
    if (typed) return { value: typed.value, text: answer };
    throw new Error(`no option "${answer}" for: ${question}`);
  }

  async secret(question: string): Promise<string> {
    return this.answer(question);
  }

  async text(question: string): Promise<string> {
    return this.answer(question);
  }

  private answer(question: string): string {
    this.asked.push(question);
    const key = Object.keys(this.answers).find((fragment) => question.includes(fragment));
    if (key === undefined) throw new Error(`unexpected question: ${question}`);
    return this.answers[key]!;
  }
}
