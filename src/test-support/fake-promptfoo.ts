import { parseCsv } from "../model-evals-data.js";
import type { Promptfoo } from "../model-evals-promptfoo.js";
import type { System } from "../system.js";

export interface FakePromptfooCall { args: string[]; env: Record<string, string>; cwd: string; timeoutMs: number; provider: { id: string; config: { apiBaseUrl: string } }; grader: { id: string; config: { apiBaseUrl: string } } }

/**
 * A stand-in for promptfoo in tests (the real one is exercised by the integration test and
 * the captured fixture): it reads the config dl wrote, answers each translated row with
 * `answer(port, input)`, checks `equals` and `contains:` the way promptfoo does, and writes
 * output in promptfoo's JSON shape (the fields dl reads).
 */
export function fakePromptfoo(system: System, answer: (port: string, input: string) => string | Error) {
  const calls: FakePromptfooCall[] = [];
  let ensured = 0;
  const promptfoo: Promptfoo = {
    async ensure() { ensured++; return "/cache/promptfoo/entrypoint.js"; },
    async run(_entry, args, options) {
      const arg = (flag: string) => args[args.indexOf(flag) + 1]!;
      const readJson = async (path: string) => JSON.parse((await system.readFile(path.replace(/^file:\/\//, "")))!) as Record<string, unknown>;
      const provider = await readJson(arg("-r")) as FakePromptfooCall["provider"];
      const grader = await readJson(arg("--grader")) as FakePromptfooCall["grader"];
      calls.push({ args: [...args], env: options.env, cwd: options.cwd, timeoutMs: options.timeoutMs, provider, grader });
      const config = await readJson(arg("-c"));
      const csv = parseCsv((await system.readFile(String(config.tests).replace(/^file:\/\//, "")))!);
      const [header, ...rows] = csv;
      const port = new URL(provider.config.apiBaseUrl).port;
      const results = rows.map((cells, testIdx) => {
        const row = Object.fromEntries(header!.map((name, index) => [name, cells[index] ?? ""]));
        const input = row.input!;
        const reply = answer(port, input);
        if (reply instanceof Error) return { success: false, failureReason: 2, error: reply.message, testIdx, prompt: { raw: input }, testCase: { description: row.__description }, response: { error: reply.message } };
        const checks = Object.entries(row).filter(([name, value]) => name.startsWith("__expected") && value.trim()).map(([, value]) => value.trim());
        const componentResults = checks.map((check) => {
          const contains = /^contains:(.*)$/.exec(check);
          const assertion = contains ? { type: "contains", value: contains[1]!.trim() } : { type: "equals", value: check };
          return { pass: contains ? reply.includes(assertion.value) : reply === check, assertion };
        });
        const threshold = row.__threshold ? Number(row.__threshold) : undefined;
        const passed = componentResults.filter((component) => component.pass).length;
        const success = threshold !== undefined ? passed / componentResults.length >= threshold : passed === componentResults.length;
        return { success, failureReason: success ? 0 : 1, testIdx, prompt: { raw: input }, testCase: { description: row.__description }, response: { output: reply },
          gradingResult: { pass: success, componentResults } };
      });
      const successes = results.filter((result) => result.success).length;
      const errors = results.filter((result) => result.failureReason === 2).length;
      await system.writeFile(arg("-o"), JSON.stringify({ results: { prompts: [{}], stats: { successes, failures: results.length - successes - errors, errors }, results } }));
      return { code: successes === results.length ? 0 : 100, timedOut: false };
    },
  };
  return { promptfoo, calls, ensured: () => ensured };
}
