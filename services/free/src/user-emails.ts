/**
 * The emails the free tier sends to the people who use it, all of them in one place so the copy is
 * easy to edit. Keep it lowercase everywhere (subjects too), and use no em or en dashes and no
 * other dashes as punctuation: a test checks this file.
 *
 * Never use the person's login or any name: every greeting is just "hey,". The one exception is
 * weekly_reset's invite link, https://dl.new/r/{login}, which carries the person's invite code (their
 * GitHub login, as the referral link has it) inside the URL. Placeholders: {resets} is the day the
 * week resets, like "monday 10 nov"; weekly_reset's {tokens} is the person's own weekly allowance
 * and {grows} the below-Full paragraph (WEEKLY_RESET_GROWS, or nothing). Every email gets FOOTER
 * after a blank line, with {unsubscribeUrl}.
 *
 * The emails are plain text, so commands are written as they are typed, without backticks.
 *
 * dl.new's paid plans have their own: welcome_paid (on claiming a payment), plan_80 and
 * plan_reset (Mondays, paying accounts only). The one capitalised line is plan_reset's subject,
 * "Your ~62M tokens reset.", as the owner wrote it.
 *
 * When each one goes out is in user-email-send.ts.
 */

export type UserEmailKind =
  | "welcome"
  | "welcome_basic"
  | "welcome_starter"
  | "welcome_starter_small"
  | "welcome_trial"
  | "access_granted"
  | "access_granted_trial"
  | "didnt_start"
  | "week_80"
  | "trial_80"
  | "plan_80"
  | "gone_quiet"
  | "weekly_reset"
  | "welcome_paid"
  | "plan_reset";

/** The welcome kinds: held back while the person waits in line for free tokens. */
export const WELCOME_KINDS: readonly UserEmailKind[] = ["welcome", "welcome_basic", "welcome_starter", "welcome_starter_small", "welcome_trial"];

/**
 * The free tier's lifecycle emails: never to accounts made on dl.new (their numbers start at
 * 2^50), which get welcome_paid, plan_80 and plan_reset instead.
 */
export const FREE_TIER_KINDS: readonly UserEmailKind[] = [...WELCOME_KINDS, "access_granted", "access_granted_trial", "didnt_start", "week_80", "trial_80", "gone_quiet", "weekly_reset"];

export interface UserEmailCopy {
  subject: string;
  body: string;
}

/** The welcome email: no amounts (they are runtime settings) and no level names. */
const WELCOME_BODY = `hey,

sina here, i build dl.

you're on the free tier now. every week you get free gpt-6 and lots of deepseek, on me. it resets every monday.

three things worth trying first:
- open dl in a repo and ask it how the project fits together
- give it a small bug you've been putting off
- ask it to write tests for one file

if anything breaks or feels off, just reply to this. it comes straight to me and i read every one.

there's also a discord where people share what they're building and help each other out: https://discord.gg/zeBnJTgcRK

sina`;

export const USER_EMAILS: Record<UserEmailKind, UserEmailCopy> = {
  // 1. Right after a new sign-up gives their email on the sign-in page.
  welcome: {
    subject: "you're in",
    body: WELCOME_BODY,
  },

  // 1b. The same moment, for a new sign-up at the basic level. Publicly there is only Free and
  // Pro, and by default every free level gets the same allowance: the same email as `welcome`.
  welcome_basic: {
    subject: "you're in",
    body: WELCOME_BODY,
  },

  // 1c. The same moment, for a new sign-up below the bar with no free tokens.
  welcome_starter: {
    subject: "you're in",
    body: `hey,

sina here, i build dl.

you're signed in. free tokens are for github accounts over a year old with 100+ contributions in the last year, and yours doesn't meet that yet, so for now you'll need your own key: run /provider in dl.

if you're a real dev building something, type /request inside dl and tell me what you're working on, and i'll sort you out with free tokens.

if /request isn't in your dl yet, email contact@directionallylocal.com with your github username instead.

there's also a discord where people share what they're building: https://discord.gg/zeBnJTgcRK

sina`,
  },

  // 1d. The same moment, for a new sign-up below the bar while Starter has an allowance: the
  // same email as `welcome` (no level names; the allowance is the free one).
  welcome_starter_small: {
    subject: "you're in",
    body: WELCOME_BODY,
  },

  // 1f. The same moment, for a new sign-up on the trial (admitted at or after the trial cutoff):
  // a one-time amount, not a weekly one. No amounts: they are runtime settings.
  welcome_trial: {
    subject: "you're in",
    body: `hey,

sina here, i build dl.

you're on the free trial now: a one-time batch of free tokens to try dl, gpt-6 and deepseek included, on me. it doesn't reset, so when it's used up you can keep going with dl pro or a top up: type /upgrade in dl.

three things worth trying first:
- open dl in a repo and ask it how the project fits together
- give it a small bug you've been putting off
- ask it to write tests for one file

if anything breaks or feels off, just reply to this. it comes straight to me and i read every one.

there's also a discord where people share what they're building and help each other out: https://discord.gg/zeBnJTgcRK

sina`,
  },

  // 1e. An admin granted the person's access request (/request in dl).
  access_granted: {
    subject: "you're in",
    body: `hey,

you're in. you now have free tokens: every model, gpt-6 included, and more free usage each week than the standard allowance. it resets every monday.

thanks for telling me what you're building. if anything breaks or feels off, just reply to this.

sina`,
  },

  // 1g. An admin granted the access request of someone on the trial: their free tokens are the
  // trial's, not a weekly allowance.
  access_granted_trial: {
    subject: "you're in",
    body: `hey,

you're in. you now have your free trial tokens: every model, gpt-6 included. they're a one-time amount, so when they're used up you can keep going with dl pro or a top up: type /upgrade in dl.

thanks for telling me what you're building. if anything breaks or feels off, just reply to this.

sina`,
  },

  // 2. Admitted 24 to 72 hours ago and no request yet.
  didnt_start: {
    subject: "did something get in the way?",
    body: `hey,

you signed up for dl but haven't run anything yet. totally fine, but if something got in the way i'd really like to know.

the two things that trip people up most:
- the install finished but dl isn't found: open a new terminal, or run source ~/.bashrc (or ~/.zshrc)
- the sign in didn't finish in the browser: run dl again and pick free

or just reply with what happened. one line helps a lot.

sina`,
  },

  // 3. A request took this week's usage past 80% of the tokens or the dollar cap.
  week_80: {
    subject: "you've used most of this week's tokens",
    body: `hey,

you've used about 80% of this week's free tokens. honestly that's great, it means dl is doing real work for you.

they reset on {resets}. if you need more before then, you can plug in your own key with /provider and keep going.

if you're building something cool with it, reply and tell me. i'm curious.

sina`,
  },

  // 3a. A paid plan's model at 80% of its weekly limit (once per model per week; plan-limits.ts).
  // {model} is the model's name, {share} the percent used, {used} {limit} {left} real tokens at
  // the plan mix, like "~50M".
  plan_80: {
    subject: "{model}: {share}% of this week used",
    body: `hey,

{model}: {share}% used ({used} of {limit} at 95.5% caching). {left} left until mon 00:00 utc.

when it runs out, dl.new switches to deepseek v4.1 flash while your plan has some left (you can turn that off in settings), or pauses until monday. there are no overage charges.

need more room every week? https://dl.new/upgrade
your usage: https://dl.new/usage

sina`,
  },

  // 3b. Someone on the trial used 80% of their trial tokens (once: the trial doesn't reset).
  trial_80: {
    subject: "you've used most of your free trial",
    body: `hey,

you've used about 80% of your free trial tokens. honestly that's great, it means dl is doing real work for you.

the trial doesn't reset. to keep going after it, type /upgrade in dl for dl pro or a top up, or plug in your own key with /provider.

if you're building something cool with it, reply and tell me. i'm curious.

sina`,
  },

  // 4. Used dl on at least 2 days, then nothing for 7 days.
  gone_quiet: {
    subject: "quick question",
    body: `hey,

you used dl for a bit and then stopped. no pressure at all, i'm just trying to learn.

what made you stop? one line is plenty, just hit reply.

sina`,
  },

  // 3c. dl.new: right after a payment is claimed onto an account (paid-web.ts). {plan} is the
  // plan's name, {limits} one line per model ("- DeepSeek V4.1 Flash ~62M/week (95.5% caching
  // applied)"), {bonus} the GPT-6 launch bonus paragraph when the account holds it, else nothing,
  // {promo} the launch offer's sentence when the first payment had it, else nothing. No refund line.
  welcome_paid: {
    subject: "your dl.new key is ready",
    body: `hey,

sina here, i build dl.new. thanks for subscribing to {plan}.{promo}

your key is waiting at https://dl.new/connect

with claude code, run this once:
    curl -fsSL dl.new | sh
then start it with:
    dl claude

other tools (opencode, cline, cursor, any openai sdk): use the base url https://api.dl.new/v1 and a key from https://dl.new/keys

to sign in again, go to https://dl.new/signin and use github or a code we email you.

your plan's weekly limits, reset every monday 00:00 utc:
{limits}
{bonus}

if anything breaks or feels off, just reply. it comes straight to me.

sina`,
  },

  // 5b. dl.new: every Monday, to paying accounts only, once free tokens have ended (freeEndsAt)
  // and while weeklyResetEmail is on (app.ts scheduledPlanReset). {tokens} is the plan's main
  // model's weekly limit ("~62M"), {plan} its name, {models} last week per model with the
  // counted math, {sessions} and {failovers} last week's counts.
  plan_reset: {
    subject: "Your {tokens} tokens reset.",
    body: `hey,

new week: your {plan} limits are back to full.

last week:
{models}

counted tokens: cached input x {cachedpct}, fresh input x 100%, output x 100%.
sessions: {sessions}
failovers: {failovers} (requests a backup provider or model answered)

your usage: https://dl.new/usage
manage or cancel your plan: https://dl.new/billing

sina`,
  },

  // 5. Every Monday after the weekly allowance resets (user-email-send.ts weeklyResetEligible):
  // active free-allowance people who used dl in the last 28 days. {tokens} is their own weekly
  // allowance; {grows} adds WEEKLY_RESET_GROWS for anyone below the Full allowance.
  weekly_reset: {
    subject: "{tokens} tokens, reset.",
    body: `hey,

new week: you have {tokens} free tokens again.

{grows}to jump back in, open your terminal and type dl
- continue your last session: dl -c
- on windows: open ubuntu (wsl), not powershell, then type dl
- not installed anymore? curl -fsSL https://dl.new | sh

two small asks:
- star dl on github: https://github.com/directionally-local/autopilot
- send dl to one friend who codes: https://dl.new/r/{login}

sina`,
  },
};

/** weekly_reset's own paragraph for people below the Full allowance; {full} is Full's weekly tokens. */
export const WEEKLY_RESET_GROWS = "it grows as you use dl, up to {full} a week.";

/**
 * A token count as the weekly_reset email says it: 1000000 is "1M", 1200000 "1.2M", 50000000
 * "50M", 500000 "500K". Rounded down to one decimal, so it never shows more than the person has.
 */
export function shortTokens(tokens: number): string {
  const whole = Math.max(0, Math.floor(tokens));
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (whole >= size) {
      const tenths = Math.floor((whole * 10) / size);
      return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}${unit}`;
    }
  }
  return String(whole);
}

/** weekly_reset's own values: the person's weekly tokens, Full's, and their invite code. */
export interface WeeklyResetValues {
  tokens: number;
  fullTokens: number;
  login: string;
}

/** plan_80's values (plan-limits.ts warningEmailValues). */
export interface PlanWarningValues {
  model: string;
  share: string;
  used: string;
  limit: string;
  left: string;
}

/** welcome_paid's values (paid-web.ts welcomeValues). */
export interface PlanWelcomeValues {
  plan: string;
  limits: string;
  bonus: string;
  /** " Your first month was 50% off. It renews at $7/mo." after a launch-offer payment, else "". */
  promo: string;
}

/** plan_reset's values (plan-reset.ts planResetValues). */
export interface PlanResetValues {
  tokens: string;
  plan: string;
  models: string;
  cachedpct: string;
  sessions: string;
  failovers: string;
}

/** Under every email, after a blank line. */
export const FOOTER = "don't want these? {unsubscribeUrl}";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "monday 10 nov", in UTC. */
export function resetsText(at: number): string {
  const date = new Date(at);
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** "dl pro or a top up" in the trial emails, as said while Pro isn't offered (`proOffered` off). */
const PRO_OR_TOPUP = /dl pro or a top up/g;

/**
 * One email, placeholders filled in, footer added. `proOffered` false leaves dl pro out of it (top
 * ups stay). `weeklyReset` fills weekly_reset's {tokens}, {grows} and {login}.
 */
export function renderUserEmail(
  kind: UserEmailKind,
  values: { resets: string; unsubscribeUrl: string; proOffered?: boolean; weeklyReset?: WeeklyResetValues; planWarning?: PlanWarningValues; planWelcome?: PlanWelcomeValues; planReset?: PlanResetValues },
): UserEmailCopy {
  const reset = values.weeklyReset;
  const named: Record<string, string> = {
    resets: values.resets,
    unsubscribeUrl: values.unsubscribeUrl,
    ...(reset
      ? {
          tokens: shortTokens(reset.tokens),
          grows: reset.tokens < reset.fullTokens ? `${WEEKLY_RESET_GROWS.replace("{full}", shortTokens(reset.fullTokens))}\n\n` : "",
          login: reset.login,
        }
      : {}),
    ...(values.planWarning ?? {}),
    ...(values.planWelcome ?? {}),
    ...(values.planReset ?? {}),
  };
  const fill = (text: string) => {
    const filled = text.replace(/\{(\w+)\}/g, (match, name: string) => named[name] ?? match);
    return values.proOffered === false ? filled.replace(PRO_OR_TOPUP, "a top up") : filled;
  };
  const copy = USER_EMAILS[kind];
  return { subject: fill(copy.subject), body: `${fill(copy.body)}\n\n${fill(FOOTER)}\n` };
}
