/**
 * key-education.ts -- what a person should understand about a key
 * before they make one, in plain words. Shown wherever a key is made
 * (components/KeySafety.tsx).
 *
 * Operator, 2026-11-11, after deciding NOT to add a roll-your-own-seed
 * feature here: "I would like to have the education be informative of
 * entropy and a good seed and why you shouldn't have a low entropy
 * seed ... we are using multisig so that helps some but I don't want
 * to skimp on security ... it's still a hot key."
 *
 * Every line here is a claim made to a person about their money.
 * scripts/test-password-rules.mjs pins the ones that must never be
 * softened: a browser key is called a hot key, and nothing says a
 * password or a vault makes it as safe as a hardware wallet.
 */

export interface KeyLesson { title: string; body: string }

export const KEY_LESSONS: readonly KeyLesson[] = [
  {
    title: 'The 24 words are the key',
    body: 'Whoever has the words can sign as you. Without them, nobody can -- not you, not us. There is no reset.',
  },
  {
    title: 'A good key comes from real randomness',
    body: 'This app makes your words from your device\'s secure random source: 256 coin-flips\' worth, far too many possibilities for anyone to guess. Never choose the words yourself, and never use words from a website, a book, a photo or a pattern. Programs run day and night trying every phrase a person might think up, and a guessable key is found and emptied.',
  },
  {
    title: 'A key in a browser is a hot key',
    body: 'It lives on a phone or computer that is online. That makes it convenient, and it means a tampered website, a bad browser add-on or malware on the device could take it at the moment you unlock it. No password changes that. A hardware wallet keeps its key in a separate device that never goes online.',
  },
  {
    title: 'The password locks the words on this device',
    body: 'It protects them if the phone is lost, stolen or copied. Four or more unrelated words, used nowhere else, is a good password. If you forget it, the 24 words still bring the key back.',
  },
  {
    title: 'Why a vault with several keys helps',
    body: 'A vault needs more than one key to move coins, so one stolen hot key is not enough on its own. That only holds if the keys are truly separate: for savings that matter, make at least one key on each path a hardware wallet.',
  },
  {
    title: 'Want to make your own seed with dice?',
    body: 'Do that on a signing device built for it, such as a Coldcard or a SeedSigner, and bring only its public key here with Import xpub. A browser is the wrong place for that ceremony.',
  },
];

/** Shown where someone types in existing words (restore). The one way
 *  a weak seed can enter this app is by being brought in. */
export const RESTORE_WARNING =
  'Only restore words that this app or a signing device generated. Words you made up, or took from a website, a book or a pattern, are guessable, and a guessable key is emptied.';
