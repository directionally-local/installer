/**
 * Security work is served by DeepSeek only, never GPT-6. OpenAI flags security requests on GPT-6
 * against our organisation ("Cyber Abuse" warnings), so a person doing security work (defensive
 * or offensive) keeps DeepSeek V4.1 Flash and is refused GPT-6 with the GPT-6 limit's refusal
 * (402 gpt_limit, `alternative` DeepSeek, `reason` "security"), which every client already turns
 * into "switch to DeepSeek".
 *
 * Two ways a (person, session) is held off GPT-6, and the person with it for the rest of the UTC day:
 *
 *   1. Its use description (use-description.ts) says security: a category in SECURITY_CATEGORIES
 *      or a "high" risk. The description is made after the session's first request, so this
 *      catches the requests after it.
 *   2. Before a GPT-6 request is forwarded, the latest user message (its first
 *      SECURITY_PRECHECK_CHARS characters) matches one of SECURITY_SIGNALS: plain regular
 *      expressions, run locally, no network call. This catches the first request.
 *
 * DeepSeek requests and admins are never affected; the `securityOffGpt6` runtime setting turns it
 * off. Holds and refusal counts live in the Directory (`gpt6_holds`, `security_refusals_daily`).
 */

import type { UseLabel } from "./use-description.js";

/** The refusal's message (code gpt_limit). */
export const SECURITY_GPT6_MESSAGE = "GPT-6 isn't available for security work on the free tier. DeepSeek V4.1 Flash still works: switch with /model.";

/** The gpt_limit refusal's `reason` for security work (the weekly limit's are "tokens" / "usd"). */
export const SECURITY_REASON = "security";

/** Use-description categories that hold a session off GPT-6 (a "high" risk does too, whatever its category). */
export const SECURITY_CATEGORIES: ReadonlySet<string> = new Set(["security-defensive", "security-offensive", "malware", "credential-theft"]);

/** Whether a session's use description holds it (and its person, for the day) off GPT-6. */
export function labelKeepsOffGpt6(label: Pick<UseLabel, "risk" | "category"> | undefined): boolean {
  return label !== undefined && (label.risk === "high" || SECURITY_CATEGORIES.has(label.category));
}

/** How much of the latest user message the pre-check reads (4 KB of text). */
export const SECURITY_PRECHECK_CHARS = 4096;

/**
 * Words that make an otherwise ordinary term (a packet capture, "the flag", brute force) read as
 * security work. Used only together with another term, never alone.
 */
const SECURITY_CONTEXT =
  /\b(ctf|capture[ -]the[ -]flag|challenge|crackme|pwn\w*|exploit\w*|malicious|malware|attack(er|s|ing)?|intrusion|exfiltrat\w*|covert|tunnel(l?ing)?|c2|beacon\w*|steg\w*|forensic\w*|incident response|credentials?|passwords?|hashes|decrypt\w*|victim|unauthori[sz]ed)\b/i;

/**
 * The pre-check's rules: a rule matches when every one of its patterns matches the text. Single
 * patterns are terms or phrases that only security work uses; ordinary coding words that also have
 * a security sense ("flag", "payload", "inject", "brute force", "exploit", "bypass", "C2") appear
 * only as phrases or together with SECURITY_CONTEXT, so a feature flag, a JSON payload,
 * dependency injection or a brute-force algorithm never match. All case-insensitive.
 *
 * Keep each `id` stable: it is what tests name. Add to it freely; a false positive costs someone
 * GPT-6 for a day (DeepSeek still works), a miss can cost a warning on the OpenAI organisation.
 */
export const SECURITY_SIGNALS: ReadonlyArray<{ id: string; all: readonly RegExp[] }> = [
  // CTFs: the name, a flag format (flag{…}, picoCTF{…}, HTB{…}), or asking for the flag.
  { id: "ctf", all: [/\b(ctfs?|capture[ -]the[ -]flag|crackmes?|pwnable)\b/i] },
  { id: "flag-format", all: [/(?<!\b(if|while|match|else|return)\s*)\b(flag|ctf|picoctf|htb|thm|ductf|uiuctf|csaw|hitcon|hackthebox)\{[\w!?@#$.-]{3,}\}/i] },
  { id: "give-flag", all: [/\b(give|capture|submit|recover|obtain|reveal)\s+(me\s+)?(the\s+)?flag\b/i] },
  { id: "flag-in-challenge", all: [/\bthe\s+flag\b/i, /\b(challenge|pcap\w*|wireshark|crackme|ghidra|disassembl\w*|reverse[- ]engineer\w*|steg\w*|pwn\w*|exploit\w*|decrypt\w*)\b/i] },
  // Packet captures read for an attack, a tunnel, credentials or a flag (not parsing pcap files in general).
  { id: "packet-capture", all: [/\b(pcap(ng)?|\.pcap(ng)?|wireshark|tshark|tcpdump|packet captures?)\b/i, SECURITY_CONTEXT] },
  { id: "dns-tunnel", all: [/\bdns\s+(tunnel(l?ing)?|exfiltrat\w*)\b/i] },
  { id: "exfiltration", all: [/\bexfiltrat(e|es|ed|ing|ion)\b/i] },
  // Shells and exploits.
  { id: "reverse-shell", all: [/\b(reverse|bind)[ -]?shells?\b|\bweb ?shells?\b/i] },
  { id: "shellcode", all: [/\bshell ?code\b/i] },
  { id: "privilege-escalation", all: [/\bprivilege[ -]escalation\b|\bprivesc\b|\bescalat(e|ing)\s+(my\s+|our\s+|to\s+)?(root\s+)?privileges?\b|\bget(ting)?\s+root\s+(access\s+)?on\b/i] },
  { id: "write-exploit", all: [/\b(write|writing|develop|craft|build|create|weaponi[sz]e|working)\s+(an?\s+|the\s+|me\s+an?\s+)?(working\s+)?(exploit|0-?day|zero-?day)s?\b|\bexploit\s+(code|poc|chain|for\s+cve)\b|\b(rce|lpe|buffer overflow|heap overflow|use[- ]after[- ]free|format string)\s+exploit\b|\brop\s?chain\b|\bheap spray\w*\b/i] },
  { id: "cve-exploit", all: [/\bcve-\d{4}-\d{4,}\b/i, /\b(exploit\w*|poc|proof of concept|payload|weaponi[sz]e|rce)\b/i] },
  // Offensive tools.
  { id: "tools", all: [/\b(sqlmap|metasploit|msfconsole|msfvenom|meterpreter|mimikatz|hashcat|john the ripper|cobalt ?strike|burp ?suite|gobuster|dirbuster|nikto|aircrack(-ng)?|impacket|crackmapexec|evil-?winrm|responder\.py|thc-hydra|bloodhound)\b/i] },
  { id: "nmap", all: [/\bnmap\b/i] },
  { id: "pentest", all: [/\b(pen ?test(ing|er|s)?|penetration test(ing|er|s)?|red[- ]team(ing)? engagement)\b/i] },
  // Breaking into accounts and passwords.
  { id: "brute-force", all: [/\bbrute[ -]?forc(e|ed|es|ing)\b/i, /\b(password|passwd|login|ssh|rdp|ftp|credential|pin|otp|2fa|mfa|wp-login|admin panel)s?\b/i] },
  { id: "crack-password", all: [/\bcrack(ing)?\s+(the\s+|a\s+|this\s+|their\s+|my\s+)?(password|hash|wi-?fi|wpa2?|wep|zip password|license key|serial)(es|s)?\b/i] },
  { id: "credential-theft", all: [/\b(credential (stuffing|harvest\w*|dump\w*)|password spray\w*|account takeover|session hijack\w*|cookie steal\w*|token grabber|info-?stealer|steal(ing)?\s+(their\s+|the\s+|user'?s?\s+|someone'?s\s+)?(passwords?|credentials?|cookies?|session tokens?|tokens?|accounts?))\b/i] },
  { id: "bypass-2fa", all: [/\bbypass(ing|es)?\s+(the\s+)?(2fa|mfa|two[- ]factor|otp|captcha|waf|edr|antivirus|anti-?virus|av detection|amsi|uac|drm|license check|paywall)\b|\b(auth|authentication|login|2fa|mfa)\s+bypass\b/i] },
  { id: "bypass-auth", all: [/\bbypass(ing|es)?\s+(the\s+)?(auth|authentication|login)\b(?!\s+(in|for|during|when)\s+(tests?|testing|dev|development|local|e2e|storybook|ci)\b)/i] },
  { id: "hack-into", all: [/\bhack(ing)?\s+(into\s+)?(someone'?s?|somebody'?s?|my ex'?s?|their|his|her)\b|\bhack(ing)?\s+into\s+(an?\s+|the\s+|this\s+)?(\w+\s+)?(account|server|system|network|computer|phone|wi-?fi|database|website|router|camera)s?\b|\bhack(ing)?\s+(an?\s+|the\s+)?(instagram|facebook|whatsapp|snapchat|tiktok|gmail|email|wi-?fi|phone)\b/i] },
  // Malware and abuse.
  { id: "phishing", all: [/\bphish(ing|er|ers|y)?\b/i] },
  { id: "keylogger", all: [/\bkey ?logg(er|ers|ing)\b/i] },
  { id: "malware", all: [/\b(malware|ransomware|rootkits?|spyware|botnets?|remote access trojan|cryptojack\w*|infostealer|wiper malware)\b/i] },
  { id: "ddos", all: [/\b(d?dos\s+(attack|tool|script)s?|ddos(ing|ed)?|denial[- ]of[- ]service|ip stresser|booter)\b/i] },
  { id: "c2", all: [/\b(command[- ]and[- ]control|c&c\s+server|c2\s+(server|channel|beacon|framework|infrastructure|implant|agent|traffic))\b/i] },
  { id: "av-evasion", all: [/\b(evade|evading|evasion of|avoid)\s+(antivirus|anti-?virus|av|edr|defender)\b|\bundetectable\s+(payload|malware|backdoor|exe)\b|\bbackdoor(ed|ing)?\s+(a|the|this)\b/i] },
  // Injection used as an attack: payloads and named attacks, never "dependency injection".
  { id: "injection", all: [/\b(sqli|xss|xxe|ssti|ssrf|csrf token bypass)\b|\b(sql|nosql|command|os command|ldap|xpath|template|code|header|crlf)\s+injection\s+(payload|attack|exploit|vulnerabilit(y|ies)|test)s?\b|\binjection payloads?\b|\b(exploit|perform|test for|find)\w*\s+(an?\s+)?(sql|nosql|command|ldap|xpath|template)\s+injection\b/i] },
  { id: "payload-strings", all: [/'\s*or\s+'?1'?\s*=\s*'?1|'\s*union\s+(all\s+)?select\b|<script>\s*alert\(|onerror\s*=\s*alert\(|\.\.\/\.\.\/(\.\.\/)*etc\/(passwd|shadow)|\/etc\/shadow\b|\{\{\s*7\s*\*\s*7\s*\}\}/i] },
  { id: "malicious-payload", all: [/\b(malicious|reverse shell|meterpreter|staged|stageless|obfuscated|encoded)\s+payloads?\b/i] },
];

/**
 * The first rule the latest user message's text matches, by `id`, or undefined for none. Only the
 * first SECURITY_PRECHECK_CHARS characters are read.
 */
export function securitySignal(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const head = text.length > SECURITY_PRECHECK_CHARS ? text.slice(0, SECURITY_PRECHECK_CHARS) : text;
  for (const rule of SECURITY_SIGNALS) {
    if (rule.all.every((pattern) => pattern.test(head))) return rule.id;
  }
  return undefined;
}

/** When a security hold made today ends: the next UTC midnight, as an ISO time. */
export function securityHoldEnds(now: number): string {
  const day = 86_400_000;
  return new Date((Math.floor(now / day) + 1) * day).toISOString();
}
