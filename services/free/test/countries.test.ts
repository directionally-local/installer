import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, NOW, type Service } from "./harness.js";
import { ConfigError, readFreeConfig } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { requestRefusalReason } from "../src/refusals.js";
import {
  EMBARGO_MESSAGE,
  EMBARGOED_COUNTRIES,
  GPT6_COUNTRY_MESSAGE,
  gpt6CountryAllowed,
  isEmbargoed,
  OPENAI_SUPPORTED_COUNTRIES,
  requestCountry,
  type CountryRules,
} from "../src/countries.js";

/**
 * Country rules (countries.ts): GPT-6 only from OpenAI's supported countries, and no free-tier
 * access at all from US-embargoed ones, by the country Cloudflare gives each request.
 */

const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const GPT6 = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };
const RULES: CountryRules = { countryRules: "enforce", gpt6Countries: OPENAI_SUPPORTED_COUNTRIES, embargoedCountries: EMBARGOED_COUNTRIES };

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", ...BOTH, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token };
}

const from = (country: string | undefined): Record<string, string> => (country ? { "cf-ipcountry": country } : {});

const chat = (service: Service, token: string, model: string, country?: string) =>
  service.request("POST", "/v1/chat/completions", { token, headers: from(country), body: { model, messages: [{ role: "user", content: "hello" }] } });

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

async function refusals(service: Service, admin: string): Promise<Record<string, number>> {
  const response = await service.request("GET", "/admin/metrics", { token: admin });
  const body = (await response.json()) as { refusals: Array<{ day: string; reason: string; client: string; count: number }> };
  return Object.fromEntries(body.refusals.filter((row) => row.day === TODAY).map((row) => [`${row.reason}|${row.client}`, row.count]));
}

describe("country rules (units)", () => {
  it("reads Cloudflare's country from request.cf, else CF-IPCountry", () => {
    const withCf = new Request("https://x/") as Request & { cf?: unknown };
    Object.defineProperty(withCf, "cf", { value: { country: "jp" } });
    assert.equal(requestCountry(withCf), "JP");
    assert.equal(requestCountry(new Request("https://x/", { headers: { "cf-ipcountry": "T1" } })), "T1");
    assert.equal(requestCountry(new Request("https://x/", { headers: { "cf-ipcountry": "Japan" } })), undefined);
    assert.equal(requestCountry(new Request("https://x/")), undefined);
  });

  it("serves GPT-6 in supported countries only; Tor and unknown don't get it; no country at all isn't held", () => {
    for (const [country, allowed] of [["JP", true], ["US", true], ["SG", true], ["CN", false], ["RU", false], ["HK", false], ["IR", false], ["T1", false], ["XX", false], [undefined, true]] as const) {
      assert.equal(gpt6CountryAllowed(RULES, country), allowed, String(country));
    }
    assert.equal(gpt6CountryAllowed({ ...RULES, countryRules: "off" }, "CN"), true);
    for (const country of ["CU", "IR", "KP", "SY"]) assert.equal(isEmbargoed(RULES, country), true, country);
    for (const country of ["UA", "JP", "T1", "XX", undefined]) assert.equal(isEmbargoed(RULES, country), false, String(country));
    assert.equal(isEmbargoed({ ...RULES, countryRules: "off" }, "IR"), false);
  });

  it("keeps OpenAI's list as read (208 codes, none embargoed)", () => {
    assert.equal(OPENAI_SUPPORTED_COUNTRIES.length, 208);
    assert.equal(new Set(OPENAI_SUPPORTED_COUNTRIES).size, 208);
    for (const code of EMBARGOED_COUNTRIES) assert.ok(!OPENAI_SUPPORTED_COUNTRIES.includes(code), code);
  });

  it("parses the settings from env and the admin API", () => {
    const config = readFreeConfig(BASE_ENV);
    assert.equal(config.countryRules, "enforce");
    assert.deepEqual(config.gpt6Countries, OPENAI_SUPPORTED_COUNTRIES);
    assert.deepEqual(config.embargoedCountries, ["CU", "IR", "KP", "SY"]);
    const set = readFreeConfig({ ...BASE_ENV, COUNTRY_RULES: "OFF", GPT6_COUNTRIES: "us, gb,US", EMBARGOED_COUNTRIES: "" });
    assert.deepEqual([set.countryRules, set.gpt6Countries, set.embargoedCountries], ["off", ["US", "GB"], []]);
    assert.throws(() => readFreeConfig({ ...BASE_ENV, GPT6_COUNTRIES: "USA" }), ConfigError);
    assert.throws(() => readFreeConfig({ ...BASE_ENV, COUNTRY_RULES: "on" }), ConfigError);
    assert.deepEqual(parseSettingsUpdate({ gpt6Countries: ["jp", "SG"], countryRules: "off" }), {
      changes: [
        { key: "gpt6Countries", value: ["JP", "SG"] },
        { key: "countryRules", value: "off" },
      ],
    });
    assert.ok("error" in parseSettingsUpdate({ embargoedCountries: ["Iran"] }));
    assert.equal(requestRefusalReason(402, { code: "provider_limit", reason: "country" }), "provider_limit:country");
  });
});

describe("GPT-6 by country", () => {
  it("refuses GPT-6 outside OpenAI's supported countries with provider_limit country, pointing at DeepSeek", async () => {
    const { service, admin, token } = await world();
    for (const country of ["CN", "T1", "XX"]) {
      const refused = await chat(service, token, "gpt-6-luna", country);
      assert.equal(refused.status, 402, country);
      const error = await errorOf(refused);
      assert.deepEqual(
        { code: error.code, reason: error.reason, family: error.family, provider: error.provider, alternative: error.alternative, resetsAt: error.resetsAt, message: error.message },
        { code: "provider_limit", reason: "country", family: "gpt6", provider: "openai", alternative: MODEL, resetsAt: null, message: GPT6_COUNTRY_MESSAGE },
      );
    }
    assert.equal(service.calls.openai.length, 0, "nothing reached OpenAI");
    assert.equal((await chat(service, token, MODEL, "CN")).status, 200, "DeepSeek works there");
    assert.equal((await chat(service, token, "gpt-6-luna", "JP")).status, 200);
    assert.equal((await chat(service, token, "gpt-6-luna")).status, 200, "no country (no Cloudflare in front): not held");
    assert.equal((await refusals(service, admin))["provider_limit:country|autopilot"], 3);
  });

  it("holds admins to it too, and leaves GPT-6 out of /v1/models, /v1/me and the unknown-model refusal there", async () => {
    const { service, admin, token } = await world();
    assert.equal((await chat(service, admin, "gpt-6-luna", "CN")).status, 402);
    const models = (await (await service.request("GET", "/v1/models", { token, headers: from("CN") })).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(models.data.map((model) => model.id), [MODEL]);
    const me = (await (await service.request("GET", "/v1/me", { token, headers: from("RU") })).json()) as { models: string[] };
    assert.deepEqual(me.models, [MODEL]);
    const meHome = (await (await service.request("GET", "/v1/me", { token, headers: from("JP") })).json()) as { models: string[] };
    assert.deepEqual(meHome.models, [...GPT6, MODEL]);
    const unknown = await chat(service, token, "gpt-5", "CN");
    assert.deepEqual((await errorOf(unknown)).allowed, [MODEL]);
  });

  it("follows the runtime settings: a country added to gpt6Countries, or the rules off", async () => {
    const { service, admin, token } = await world();
    assert.equal((await chat(service, token, "gpt-6-luna", "CN")).status, 402);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { gpt6Countries: [...OPENAI_SUPPORTED_COUNTRIES, "CN"] } })).status, 200);
    assert.equal((await chat(service, token, "gpt-6-luna", "CN")).status, 200);
    assert.equal((await chat(service, token, "gpt-6-luna", "T1")).status, 402, "Tor never gets GPT-6 while the rules are on");
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { countryRules: "off" } })).status, 200);
    assert.equal((await chat(service, token, "gpt-6-luna", "T1")).status, 200);
  });
});

describe("embargoed countries", () => {
  it("refuse all free-tier access, sign-in included, with a plain message, and count it", async () => {
    const { service, admin, token } = await world();
    const code = await service.request("POST", "/v1/device/code", { headers: from("IR"), body: {} });
    assert.equal(code.status, 403);
    const error = await errorOf(code);
    assert.deepEqual([error.code, error.reason, error.message], ["country_not_supported", "embargo", EMBARGO_MESSAGE]);

    const page = await service.request("GET", "/device", { headers: from("KP") });
    assert.equal(page.status, 403);
    assert.equal(await page.text(), EMBARGO_MESSAGE);

    const deepseek = await chat(service, token, MODEL, "CU");
    assert.equal(deepseek.status, 403);
    assert.equal((await errorOf(deepseek)).code, "country_not_supported");
    assert.equal((await service.request("GET", "/v1/me", { token, headers: from("SY") })).status, 403);

    const anthropic = await service.request("POST", "/anthropic/v1/messages", { token: "x", headers: from("IR"), body: {} });
    assert.equal(anthropic.status, 403);
    assert.deepEqual(await anthropic.json(), { type: "error", error: { type: "permission_error", message: EMBARGO_MESSAGE, code: "country_not_supported" } });

    assert.equal((await service.request("GET", "/health", { headers: from("IR") })).status, 200);
    assert.equal(service.calls.luminal.length, 0);
    const counts = await refusals(service, admin);
    assert.equal(counts["country_embargoed|signin"], 2);
    assert.equal(counts["country_embargoed|other"], 3);
  });

  it("follow the runtime setting", async () => {
    const { service, admin, token } = await world();
    assert.equal((await chat(service, token, MODEL, "IR")).status, 403);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { embargoedCountries: [] } })).status, 200);
    assert.equal((await chat(service, token, MODEL, "IR")).status, 200);
    assert.equal((await chat(service, token, "gpt-6-luna", "IR")).status, 402, "still no GPT-6: not an OpenAI country");
  });
});
