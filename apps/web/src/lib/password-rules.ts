/**
 * password-rules.ts -- how strong the password that locks a key on a
 * device must be. Pure.
 *
 * A DynastyTrust seed is always machine-made at 256 bits, so its
 * strength is not the user's to get wrong. The password is: it is the
 * only thing between a lost or stolen phone and the seed stored on it,
 * and until 2026-11-11 the bar was eight characters of anything, real
 * bitcoin included. Operator, that day: "I don't want to skimp on
 * security."
 *
 * The rule is deliberately simple enough to say out loud: for a
 * real-bitcoin key, at least twelve characters that are not a pattern
 * or a word everyone tries first. Test-coin keys keep the old minimum.
 * keystore.ts enforces this wherever a password is SET; a key locked
 * with an older, weaker password still opens.
 */

export const MIN_REAL = 12;
export const MIN_TEST = 8;

type AnyNetwork = 'mainnet' | 'bitcoin' | 'signet' | 'testnet';
const isReal = (n: AnyNetwork): boolean => n === 'mainnet' || n === 'bitcoin';

// The handful every guessing program tries first, as the stem of a password.
const FIRST_GUESSES = ['password', 'passwort', 'bitcoin', 'satoshi', 'dynastytrust', 'dynasty', 'qwerty', 'letmein', 'iloveyou', 'welcome', 'admin', '123456', 'abc123'];

/** Mostly a run like 123456789012 or abcdefghijkl (either direction). */
function isSequence(s: string): boolean {
  let steps = 0;
  for (let i = 1; i < s.length; i++) if (Math.abs(s.charCodeAt(i) - s.charCodeAt(i - 1)) <= 1) steps++;
  return steps / (s.length - 1) > 0.8;
}

/** Why this password may not lock a key on this network, or null. */
export function passwordProblem(password: string, network: AnyNetwork): string | null {
  if (!isReal(network)) {
    return password.length < MIN_TEST ? `Password must be at least ${MIN_TEST} characters` : null;
  }
  if (password.length < MIN_REAL) {
    return `A real-bitcoin key needs a password of at least ${MIN_REAL} characters. This has ${password.length}.`;
  }
  const lower = password.toLowerCase();
  if (new Set(lower).size < 6 || /^(.{1,6})\1+$/.test(lower)) {
    return 'That password repeats itself too much to be hard to guess. Use more different characters.';
  }
  if (isSequence(lower)) {
    return 'That password is a simple run of neighbouring characters, which is one of the first things tried.';
  }
  const letters = lower.replace(/[^a-z0-9]/g, '');
  const stem = FIRST_GUESSES.find(w => letters.includes(w));
  if (stem && password.length < 20) {
    return `That password is built on "${stem}", one of the first words anyone tries. Choose something unrelated.`;
  }
  return null;
}

export interface PasswordHint { level: 'empty' | 'weak' | 'ok' | 'strong'; text: string }

/** What to tell someone as they type. Never claims more than the rule knows. */
export function passwordHint(password: string, network: AnyNetwork): PasswordHint {
  if (!password) {
    return { level: 'empty', text: isReal(network) ? `At least ${MIN_REAL} characters. Four or more unrelated words is ideal.` : `At least ${MIN_TEST} characters.` };
  }
  const problem = passwordProblem(password, network);
  if (problem) return { level: 'weak', text: problem };
  const words = password.trim().split(/[\s\-_.]+/).filter(w => w.length >= 3);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length;
  if ((words.length >= 4 && password.length >= 16) || (password.length >= 16 && classes >= 3)) {
    return { level: 'strong', text: 'Strong. Use it nowhere else, and remember the 24 words are still your backup.' };
  }
  return { level: 'ok', text: 'Acceptable. Longer is stronger: four or more unrelated words is ideal.' };
}
