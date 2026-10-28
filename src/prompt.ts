import { openSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";

/** Questions `up` asks. Tests and unattended installs answer them without a terminal. */
export interface Prompter {
  choose(question: string, options: Array<{ value: string; label: string }>, fallback: string): Promise<string>;
  /** Hidden input for keys and tokens. */
  secret(question: string): Promise<string>;
  text(question: string): Promise<string>;
}

/**
 * Reads from /dev/tty, so prompts work under `curl … | sh` where stdin is the script.
 * Without a terminal every question fails with the env var that answers it.
 */
export class TtyPrompter implements Prompter {
  async choose(question: string, options: Array<{ value: string; label: string }>, fallback: string): Promise<string> {
    const lines = options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n");
    const answer = (await this.ask(`${question}\n${lines}\nChoice [1]: `, false)).trim();
    if (!answer) return options[0]?.value ?? fallback;
    const index = Number(answer) - 1;
    return options[index]?.value ?? options.find((option) => option.value === answer)?.value ?? fallback;
  }

  secret(question: string): Promise<string> {
    return this.ask(question, true);
  }

  text(question: string): Promise<string> {
    return this.ask(question, false);
  }

  private ask(question: string, hidden: boolean): Promise<string> {
    let fd: number;
    try {
      fd = openSync("/dev/tty", "r+");
    } catch {
      throw new Error("No terminal to ask on; pass the answers as environment variables (see `dl --help`).");
    }
    const input = new ReadStream(fd);
    const output = new WriteStream(fd);
    // A styled prompt is "label line\n› ": print the label line ourselves and give readline
    // only the last line, so its redraws (and the hidden-input filter) stay on one line.
    const split = question.lastIndexOf("\n");
    const head = split >= 0 ? question.slice(0, split + 1) : "";
    const line = split >= 0 ? question.slice(split + 1) : question;
    if (head) output.write(head);
    return new Promise((resolve) => {
      const rl = createInterface({ input, output, terminal: true });
      if (hidden) {
        // Echo nothing while the secret is typed.
        (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
          if (text.includes(line)) output.write(text);
        };
      }
      rl.question(line, (answer) => {
        if (hidden) output.write("\n");
        rl.close();
        input.destroy();
        output.destroy();
        try { closeSync(fd); } catch { /* already closed with the streams */ }
        resolve(answer.trim());
      });
    });
  }
}

/** Answers from a map (tests); a missing answer is a test bug, so it throws. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];

  constructor(private readonly answers: Record<string, string>) {}

  async choose(question: string): Promise<string> {
    return this.answer(question);
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
