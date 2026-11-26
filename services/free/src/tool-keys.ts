/**
 * Tool keys: dl's free tokens in any OpenAI- or Anthropic-compatible tool (Cursor, Cline, Roo,
 * Kilo, Continue, Zed, Aider, OpenCode…). A tool key is a `dlk_` key of kind "tool"
 * (account-object.ts KEY_KINDS) that a person makes with `dl api-key` (POST /v1/keys
 * {name, kind: "tool"}) and pastes into the tool with one of the base URLs:
 *
 *   OpenAI-style tools     <service>/v1             (POST /v1/chat/completions, GET /v1/models)
 *   Anthropic-style tools  <service>/anthropic      (POST /anthropic/v1/messages; DeepSeek answers)
 *
 * Who may make one: any account in good standing, the people the sign-up checks gave free
 * tokens to (not blocked or suspended, not below the bar with no free tokens). What a tool key
 * gets is what another coding agent dl launches gets: the same weekly allowance, on the share
 * other agents may use (`otherHarnessShare`); every model but GPT-6 (Autopilot only while
 * `gpt6Clients` is "autopilot"); and every guard (moderation, the allocator, account-pooling
 * routers, the caps, blocks). It is never refused as dl_only. Each key has its own rate limit
 * (`toolKeyRequestsPerMinute`) under the person's; `toolKeys` off refuses them all.
 *
 * Which tool sent a request is read from its User-Agent (and the `X-Title`/`HTTP-Referer`
 * headers OpenRouter-style clients send) and kept as the request's client, `tool:<name>`, so
 * usage and refusals show which tools people use. Names only: no header is stored as it was.
 */

/** Known tools, in the order they are tested; the first match names the request. */
const TOOLS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ["cursor", /cursor/i],
  ["kilo", /kilo/i],
  ["roo", /roo[-_ ]?(code|cline)|roocode/i],
  ["cline", /cline/i],
  ["continue", /continue/i],
  ["zed", /\bzed\b|zed\.dev/i],
  ["aider", /aider/i],
  ["opencode", /opencode/i],
  ["claude-code", /claude-cli|claude-code|claude code/i],
  ["codex", /codex/i],
  ["goose", /goose/i],
  ["crush", /crush/i],
  ["openhands", /openhands/i],
  ["windsurf", /windsurf|codeium/i],
  ["jetbrains", /jetbrains|intellij/i],
  ["litellm", /litellm/i],
  ["langchain", /langchain/i],
  ["openai-sdk", /^openai\//i],
  ["anthropic-sdk", /^anthropic\//i],
  ["curl", /^curl\//i],
  ["python", /python|aiohttp|httpx/i],
  ["node", /node|undici|axios/i],
];

export const TOOL_CLIENT_PREFIX = "tool:";

/** The tool a request came from, as a short name ("other" when none is known). */
export function toolName(headers: Headers): string {
  const seen = [headers.get("x-title"), headers.get("http-referer"), headers.get("user-agent")].filter((value): value is string => Boolean(value));
  for (const value of seen) {
    for (const [name, pattern] of TOOLS) if (pattern.test(value.slice(0, 300))) return name;
  }
  return "other";
}

/** The client recorded on a tool key's requests: `tool:<name>`. */
export function toolClient(headers: Headers): `tool:${string}` {
  return `tool:${toolName(headers)}`;
}

export const TOOL_KEYS_OFF_MESSAGE = "API keys for other tools are turned off on the free tier for now. Use your own provider key in that tool.";
export const TOOL_KEY_NOT_HERE_MESSAGE = "This is an API key for other tools: it works on /v1/chat/completions, /v1/models, /v1/me and /anthropic/v1/messages only.";
export const TOOL_KEYS_UNAVAILABLE_MESSAGE =
  "API keys for other tools are for accounts with free tokens. This account has none right now: run dl to see why, or type /request in dl to ask for access.";

/** A tool key's share of the allowance is used up (402 harness_limit, as other agents get). */
export function toolLimitMessage(share: number, resetsAt: string | undefined, plan: "free" | "pro" = "free"): string {
  const part = share >= 1 ? "all" : share <= 0 ? "none" : share === 0.5 ? "half" : `${Math.round(share * 100)}%`;
  const when = resetsAt ? ` It resets at ${resetsAt}.` : "";
  const allowance = plan === "pro" ? "Pro" : "free";
  return `Other tools on a dl API key get ${part} of your ${allowance} allowance, and that part is used up.${when}`;
}

/**
 * A refusal written for Autopilot, reworded for a tool on a dl API key: dl's slash commands are
 * typed in dl, and the model is picked in the tool.
 */
export function forTool(message: string): string {
  return message
    .replace(/: \/upgrade$/, ": run dl and type /upgrade")
    .replace(/Type \/request in dl/g, "Run dl and type /request")
    .replace(/switch with \/model, or get dl Pro\./, "pick it in the tool's model setting, or get dl Pro: run dl and type /upgrade.")
    .replace(/switch with \/model\./, "pick it in the tool's model setting.")
    .replace(/use your own key: \/provider\./, "use your own provider key in the tool.");
}
