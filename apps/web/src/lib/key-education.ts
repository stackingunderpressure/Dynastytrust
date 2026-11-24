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
    body: 'It lives on a phone or computer that is online. That makes it convenient, and it means a tampered website, a bad browser add-on or malware on the device could take it at the moment you unlock it. No password changes that, and neither does Face ID. A hardware wallet keeps its key in a separate device that never goes online.',
  },
  {
    title: 'Face ID locks the words on this device',
    body: 'It keeps them shut if the phone is lost, stolen or copied, with nothing to type or forget. On a device without Face ID, a password does the same job: four or more unrelated words, used nowhere else. Either way, if this device is gone, the 24 words bring the key back.',
  },
  {
    title: 'Lost is not the same as stolen',
    body: 'Lost: the 24 words bring back the same key, and it signs as before. A key kept in Tapit can also be rebuilt from its backup with your Tapit circle. Stolen: bringing it back changes nothing -- the thief has the same key, and nobody can cancel a Bitcoin key. Move the coins to a new vault with a fresh key (Rotate vault, on the vault page) before they can gather the other keys.',
  },
  {
    title: 'Why a vault with several keys helps',
    body: 'A vault needs more than one key to move coins, so one stolen hot key is not enough on its own -- that is what gives you time to replace the vault. It only holds if the keys are truly separate: for savings that matter, make at least one key on each path a hardware wallet. Making a seed with dice? Do it on a signing device such as a SeedSigner and bring only its public key here.',
  },
];

/** Shown where someone types in existing words (restore). The one way
 *  a weak seed can enter this app is by being brought in. */
export const RESTORE_WARNING =
  'Only restore words that this app or a signing device generated. Words you made up, or took from a website, a book or a pattern, are guessable, and a guessable key is emptied.';
