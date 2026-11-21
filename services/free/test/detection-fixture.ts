/**
 * Synthetic detection rules for tests: the DETECTION_RULES secret's shape (detection-rules.ts)
 * with made-up terms, so tests can show a secret is parsed and used. Never the production rules,
 * which live only in the secret.
 */
export const SYNTHETIC_RULES = {
  keywords: [
    // Two patterns: both must match the same text.
    { id: "widget-probe", pattern: ["\\bwidgets?\\b", "\\bprob(e|es|ing)\\b"], category: "security-offensive", risk: "low" },
    { id: "frobnicator", pattern: "\\bfrobnicator\\b", category: "security-offensive", risk: "low" },
    { id: "gizmo-stealer", pattern: "\\bgizmo[ -]?stealer\\b", category: "credential-theft", risk: "high" },
    // Case-sensitive (no "i" flag).
    { id: "zapper", pattern: "\\bZAPPER\\b", flags: "", category: "malware", risk: "high" },
  ],
  proxyRouters: ["acme[-_ ]?pool"],
  labellerPolicy: 'SYNTHETIC LABELLER POLICY: risk "high" for gizmo stealers, "low" for widget probes, "none" otherwise.',
  moderationPolicy: "SYNTHETIC MODERATION POLICY: block gizmo stealers, pass everything else.",
  thresholds: { batchSize: 7, minFollowers: 2 },
};

export const SYNTHETIC_RULES_JSON = JSON.stringify(SYNTHETIC_RULES);
