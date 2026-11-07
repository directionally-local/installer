/**
 * The emails the free tier sends to the people who use it, all four in one place so the copy is
 * easy to edit. Keep it lowercase everywhere (subjects too), and use no em or en dashes and no
 * other dashes as punctuation: a test checks this file.
 *
 * Never use the person's login or any name: every greeting is just "hey,". Placeholders:
 * {resets} is the day the week resets, like "monday 10 nov". Every email gets FOOTER after a
 * blank line, with {unsubscribeUrl}.
 *
 * When each one goes out is in user-email-send.ts.
 */

export type UserEmailKind = "welcome" | "didnt_start" | "week_80" | "gone_quiet";

export interface UserEmailCopy {
  subject: string;
  body: string;
}

export const USER_EMAILS: Record<UserEmailKind, UserEmailCopy> = {
  // 1. Right after a new sign-up gives their email on the sign-in page.
  welcome: {
    subject: "you're in",
    body: `hey,

sina here, i build dl.

you're on the free tier now. every week you get gpt-6 and deepseek tokens on me, about $17 worth. it resets every monday.

three things worth trying first:
- open dl in a repo and ask it how the project fits together
- give it a small bug you've been putting off
- ask it to write tests for one file

if anything breaks or feels off, just reply to this. it comes straight to me and i read every one.

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

they reset on {resets}. if you need more before then, you can plug in your own key with /provider and keep going, or send a friend your link from /invite and you both get extra tokens.

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
};

/** Under every email, after a blank line. */
export const FOOTER = "don't want these? {unsubscribeUrl}";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "monday 10 nov", in UTC. */
export function resetsText(at: number): string {
  const date = new Date(at);
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** One email, placeholders filled in, footer added. */
export function renderUserEmail(kind: UserEmailKind, values: { resets: string; unsubscribeUrl: string }): UserEmailCopy {
  const fill = (text: string) => text.replace(/\{(resets|unsubscribeUrl)\}/g, (_, name: "resets" | "unsubscribeUrl") => values[name]);
  const copy = USER_EMAILS[kind];
  return { subject: fill(copy.subject), body: `${fill(copy.body)}\n\n${fill(FOOTER)}\n` };
}
