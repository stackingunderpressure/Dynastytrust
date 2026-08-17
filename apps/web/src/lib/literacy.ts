/**
 * literacy.ts -- the Rabbit Hole curriculum, rungs 0 through 9.
 *
 * This is the "one place" the education-bot vision asks for: a ladder of
 * plain Socratic questions a newcomer climbs down exactly as far as their
 * stomach takes them, from "why store value at all" (rung 0, the broadest,
 * most human) down to the deepest cryptography (rung 9, the curious only).
 * Grounded faithfully in docs/sovereignty-education-bot.md section 4; this
 * file invents no doctrine -- it is the doc's ladder made into typed data.
 *
 * LAYER DISCIPLINE (a tested invariant):
 *   - `consequence` is the surface layer and MUST be jargon-free plain
 *     English -- it teaches what HAPPENS, never the mechanism. The
 *     jargon-guard test (scripts/test-literacy.mjs) fails the build if a
 *     consequence string uses crypto vocabulary.
 *   - `whyItWorks` is the middle disclosure layer; light terms allowed.
 *   - `theCrypto` is the deepest layer and MAY use full jargon -- it is
 *     only ever shown behind a deliberate "go deeper" tap.
 *
 * NO APP IMPORTS: this module is pure data with zero imports so a Node
 * test (scripts/test-literacy.mjs) can lightweight-parse the consequence
 * strings without compiling TypeScript or pulling in the Vite app graph.
 * Keep it that way.
 *
 * ASCII only; use -- for em-dash, - for en-dash. No curly quotes.
 */

export interface RungLesson {
  /** Ladder position, 0 (broadest, most human) to 9 (deepest crypto). */
  rung: number;
  /** Short name of the concept this rung teaches. */
  concept: string;
  /**
   * The surface lesson: what HAPPENS, in plain jargon-free English. This
   * is the only layer shown by default. No crypto vocabulary -- ever.
   */
  consequence: string;
  /** Middle disclosure: why the consequence is true. Light terms allowed. */
  whyItWorks?: string;
  /** Deepest disclosure, behind a "go deeper" tap. Full jargon allowed. */
  theCrypto?: string;
  /** The plain question the bot asks; answering it IS the lesson. */
  socraticQuestion?: string;
  /** Where this rung's truth already lives, so the bot consumes not invents. */
  sourcePointers?: string[];
}

export const RUNGS: Record<number, RungLesson> = {
  0: {
    rung: 0,
    concept: 'Why store value into the future at all',
    consequence:
      'You produce more energy than you spend today, and you have to park the extra somewhere it survives until you need it -- to get your yard mowed, your house built, your food on the table -- without selling your present working hours to do it. Every way of parking it has a way of failing: firewood rots and the bugs eat it, apples ferment but the brew goes flat, cash quietly loses its buying power. The real question is where your stored work survives longest with the least leak, and who can take it from you while it waits.',
    whyItWorks:
      'Money is just a way to move the work you do now into the future. The medium you choose decides how much of that work survives the trip and who can skim it on the way.',
    socraticQuestion:
      'Where does the value you save survive longest with the least leak -- and who could take it from you while it waits?',
    sourcePointers: ['docs/sovereignty-education-bot.md rung 0', 'operator firewood-vs-apples parable'],
  },
  1: {
    rung: 1,
    concept: 'Why Bitcoin, specifically',
    consequence:
      'Of all the ways to park saved-up work, this one has a property the others do not: no one -- not us, not a bank, not a government, not an ex-spouse -- can take it from you or freeze it without your cooperation. The trade you make for that power is that the responsibility is fully yours; there is no help desk to call if you lose your access. That trade is the subject of the very next rung.',
    whyItWorks:
      'Other stores of value sit inside someone else: a bank can freeze an account, an institution can change the rules, inflation can quietly drain cash. Bitcoin lives on a network no single party controls, so the only person who has to agree to move it is you.',
    socraticQuestion:
      'Of all the ways to park saved-up work, why this one -- and what do you give up to get it?',
    sourcePointers: ['docs/manifesto.md why-it-exists', 'docs/manifesto.md what-this-is-not'],
  },
  2: {
    rung: 2,
    concept: 'Self-custody and its weaknesses',
    consequence:
      'Holding your own Bitcoin means no one can take it -- and no one can save you if you slip. Every single way to hold it has a way it can go wrong: a lost phone, a fire, a forgotten password, a stolen backup, a trusted person who dies or disappears, even someone threatening you to hand it over. This is the rung where, if naming all of that honestly makes you want to walk away, that is a good answer -- this responsibility is one you accept eyes open or you should not accept at all. The cure for every weakness here is the next rung.',
    whyItWorks:
      'When you alone control the value, you alone carry every failure mode. There is no institution absorbing your mistakes -- which is exactly the freedom and exactly the cost.',
    socraticQuestion:
      'Name every way you could lose access to your own money. Which of those failures are you actually prepared for today?',
    sourcePointers: ['docs/manifesto.md normie-section', 'tapit attack-list.md'],
  },
  3: {
    rung: 3,
    concept: 'Redundancy beats every weakness',
    consequence:
      'You beat each weakness from the last rung with backups of different kinds in different hands, plus time-based safety doors, so that losing any one thing is never the end. The aim is that only an asteroid hitting the planet could take your coins. Two honest rules guide it: first, a backup that only hurts if you LOSE it needs copies, while a backup that hurts if anyone SEES it needs to be split so no single person can rebuild it -- and your access is both at once. Second, requiring more people to approve a spend is safer against any one of them but easier for YOU to get locked out, because people move, lose devices, fall out, and die. The right numbers are the ones you can actually keep available for as long as the money must last.',
    whyItWorks:
      'No single backup survives every disaster, so you spread the risk across independent copies and across people, and you add time-based doors so a lost piece is recoverable rather than fatal.',
    socraticQuestion:
      'For your own access: does it hurt if someone SEES it, or only if you LOSE it -- and how many independent ways back do you have right now?',
    sourcePointers: ['tapit 2026-06-05-sovereignty-literacy-education-spec.md (the two levers)'],
  },
  4: {
    rung: 4,
    concept: 'Things you could never do before',
    consequence:
      'Needing more than one approval to spend lets you do things a single backup never could: three siblings can share one pool of savings where none of them can run off with it; a parent can promise six figures to a 15-year-old without handing a teenager the keys today; a group with rotating leaders can keep a treasury with a clean, checkable record; you can build savings that not even you can be forced to drain at gunpoint. The point is not "more security" -- it is brand-new shapes of ownership that holding a single backup simply cannot express.',
    whyItWorks:
      'Once spending takes an agreed-on number of separate approvals, you can write rules about WHO and WHEN that a single secret could never encode -- shared control, delayed control, control that survives any one person.',
    theCrypto:
      'This is k-of-n multisig: a spending condition thresh(k, [key1..keyn]) where any k of the n keys satisfies it. DynastyTrust compiles these as Miniscript thresh() expressions.',
    socraticQuestion:
      'What is something you wish you could set up for your family that handing one person a single backup could never safely do?',
    sourcePointers: ['docs/manifesto.md why-it-exists', 'THESIS.md section 2'],
  },
  5: {
    rung: 5,
    concept: 'Locking value up: timelocks',
    consequence:
      'You can build a door that simply cannot be opened until a specific future date -- no matter who wants in, not even you under threat. People call this "locking it up for all of eternity," but that is the teachable misunderstanding: it is never eternity, it is a date YOU choose, and the app shows you "unlocks in about N months" by counting down to it. This is what makes inheritance and recovery doors possible: a path that stays sealed for years and then opens on its own.',
    whyItWorks:
      'The lock is tied to how far the Bitcoin network has counted forward, not to a wall clock, so it cannot be faked or rushed. You pick a future point; once the network passes it, the door opens, and not one moment sooner.',
    theCrypto:
      'Absolute CLTV: after(N) compiles to OP_CHECKLOCKTIMEVERIFY at a fixed block height. DynastyTrust uses absolute (not relative older()/CSV) because BIP 68 caps relative timelocks near 65,535 blocks (~15 months), too short for multi-year inheritance. The Netlify layer adds tip + offset so the leaf bakes in a real future height; see THESIS.md section 3 and CLAUDE.md.',
    socraticQuestion:
      'If you could seal a door that even you cannot open until a date you pick, what would you put behind it and how far out would you set it?',
    sourcePointers: ['THESIS.md section 3', 'CLAUDE.md timelock rule'],
  },
  6: {
    rung: 6,
    concept: 'How do I control it: the three paths',
    consequence:
      'Your vault gives you up to three separate doors, each for a different situation. The everyday door is you and your chosen group, open right now, for normal spending. The recovery door is the same group but only after a waiting period, so one person going quiet or losing access can never freeze everyone else forever. The inheritance door is your heirs on their own, after a longer wait, so value reaches the next generation without you handing them keys today. There is also an optional outside-helper door: a neutral party who can rescue the funds after a wait if things go wrong, but who has no everyday power. For your chosen setup the bot can walk you through exactly what happens if a trustee dies, if someone refuses to cooperate, if everyone goes silent for six months, or if a device is lost. One more thing worth knowing up front: this vault lives at ONE fixed address, not a fresh one every time the way many everyday Bitcoin wallets work. Every deposit into this vault, and any change that comes back after a spend, lands on that same address for as long as the vault exists. That is a deliberate choice, not an accident -- all three doors above are baked into that one address the moment the vault is created, so trustees and heirs can point at a single, durable place and see the whole history and balance for themselves. The tradeoff is privacy: anyone who learns this address, now or years from now, can see everything that has ever moved through it. If you want a genuinely separate, unlinked place to hold value -- a new starting point nobody can tie to this one just by looking at the chain -- the way to do that is to open a new vault, not to ask this one for a new address.',
    whyItWorks:
      'Each door is a separate rule with its own waiting period and its own list of who can open it. They live side by side, so the situation decides which door is the right one to use. That whole bundle of rules is compiled once into the address itself, at vault creation -- which is exactly why the address cannot quietly change later without becoming a different vault: change the doors and you get a new address; keep the same address and every deposit, spend, and leftover change stays visibly connected, to everyone who has ever looked, forever.',
    theCrypto:
      'Three Taproot leaves in a tr_multileaf descriptor: founders-now thresh(Q, founder_keys); recovery and(after(R), thresh(Q, founder_keys)); inheritance and(after(I), thresh(Q_h, heir_keys)); optional protector leaf. The bot narrates the per-template "what happens if..." playbooks in the VAULT_TEMPLATES array in lib/vault-templates.ts. DynastyTrust deliberately compiles a FIXED, non-ranged key-origin descriptor (pk([fp/path]xpub/0/0), never a wildcard pk([fp/path]xpub/0/*)) -- the compiler only ever knows how to build a spend for the exact /0/0 child baked into these leaves, so a ranged descriptor would advertise receive addresses the app could never actually spend from. change_address on every PSBT the app builds is also set to vault.address itself, not a fresh change output, so a partial spend\'s leftover sats return to the same address rather than a new one. This is the opposite of a typical HD wallet\'s gap-limit receive-address rotation (BIP 32/44/84) -- DynastyTrust trades that per-transaction unlinkability for one durable, auditable address per vault. A genuinely fresh, unlinked address means creating a new vault (a new compile, a new Taproot output), not rotating within an existing one; reusing the same founder/heir keys across multiple vaults can still let chain analysis correlate those vaults with each other even though their addresses differ, e.g. via the common-input-ownership heuristic if they are ever funded or spent together.',
    socraticQuestion:
      'Walk through your own life: who should be able to reach this money today, who should be able to recover it if you go quiet, and who should inherit it -- and how long should each wait be?',
    sourcePointers: ['VAULT_TEMPLATES playbooks in lib/vault-templates.ts'],
  },
  7: {
    rung: 7,
    concept: 'Who do I trust',
    consequence:
      'This is the hardest question and it has honest answers. You can trust yourself across time, by keeping your own backups in different safe places. You can trust named people -- family as your group or your heirs -- with the blunt warning that family arrangements work until they do not over a 50-year horizon, through conflict, death, drift, and falling-out. You can trust an arrangement instead of a name: outside helpers who only matter on the recovery and inheritance doors, who are paid and held to a reputation rather than known personally, so no one can come threaten a helper whose name they do not even know. Or you can trust Bitcoin itself and almost no one else: the network enforces the rules of your vault, while our service only helps organize the paperwork -- so even if someone broke into our servers, they could not move a single coin. The more you understand that last point, the less you have to trust us at all. And if this app itself ever goes away for good, getting your coins out does not require us at all: any other Bitcoin wallet that understands your vault rules and can read a small code you scan or paste will rebuild the exact same vault and let you sign your way out, using nothing but a printed page and your own key.',
    whyItWorks:
      'Bitcoin enforces the actual spending rules; the app only coordinates the surrounding information. Knowing which part is enforced by math and which part is just convenience is what lets you decide how little you need to trust anyone, including us. Two open, published formats carry you out the door: one plain-language description of exactly what your vault\'s rules are, and one file that carries a pending transaction waiting on a signature. Any competent Bitcoin wallet software can read both, because DynastyTrust did not invent a private format of its own -- it uses the same ones the rest of the Bitcoin world already agreed on, so no other company\'s cooperation is required either.',
    theCrypto:
      'Bitcoin enforces the script; DynastyTrust coordinates only the metadata. Compromising the server never moves a coin. The honest endpoint is Super Sovereign Mode (database on your own laptop). See docs/trustee-commons.md and docs/super-sovereign-mode.md. The two BIP-standard artifacts that carry you out, concretely: the output descriptor (tr(...) miniscript form) and, for any pending spend, a PSBT (BIP 174 / BIP 371). Any miniscript-aware wallet can import the descriptor as watch-only and rebuild every leaf and address exactly -- Sparrow via File > Import Wallet > Scan QR Code, Nunchuk via its BSMS export, Coldcard and other air-gapped signers via the same descriptor text -- and any of them can sign a PSBT DynastyTrust (or any other coordinator) produces and hand it back the same way. See lib/descriptor-backup.ts for the exact downloadable recovery bundle, which spells out these per-wallet steps in full and is built to stand alone if this app is unreachable.',
    socraticQuestion:
      'For each door in your vault, who or what are you actually trusting -- and how would that hold up across the next 50 years?',
    sourcePointers: ['docs/manifesto.md enforce-vs-coordinate', 'docs/trustee-commons.md', 'docs/super-sovereign-mode.md', 'apps/web/src/lib/descriptor-backup.ts'],
  },
  8: {
    rung: 8,
    concept: 'Proof without trust: attestations',
    consequence:
      'Bitcoin does not know what a family trust is -- but people do, so your family can sign the trust agreement in a way that is tamper-evident: change a single comma and every signature breaks and the screen plainly shows "0 of 5 agreed." The same idea lets the people in the vault periodically sign a simple "still here, all is well" so that silence becomes something you can actually see, and lets witnesses sign a declaration when someone has passed. The moment you verify one of these signatures yourself and watch it confirm, "tamper-proof" stops being a word and becomes something you have felt.',
    whyItWorks:
      'A signature is bound to the exact text it was made over. Alter the text and the signature no longer matches, so anyone checking it sees instantly that something changed -- proof that does not depend on trusting whoever is showing it to you.',
    theCrypto:
      'tapit-attest: a Schnorr/secp256k1 signature over a domain-separated tagged-hash digest of an envelope (e.g. SHA256("DT-ATT-v1" || type || 0x00 || target_hash) in lib/attest.ts). An attestation is NOT a Bitcoin spend signature -- different preimage by design, so it can never be replayed as a sighash. Kinds: trust_doc, proof_of_life, death_declaration; anchorable via OpenTimestamps.',
    socraticQuestion:
      'What agreements in your family would you want to be able to prove later were never quietly changed?',
    sourcePointers: ['tapit-attest/README.md', 'docs/manifesto.md governance layer', 'apps/web/src/lib/attest.ts'],
  },
  9: {
    rung: 9,
    concept: 'The deepest layer, for the curious only',
    consequence:
      'This is the bottom of the rabbit hole, and no one is ever made to come here. It is the actual machinery underneath everything above -- the exact math that makes a signature valid, the precise way each door is written so your wallet, our app, and other Bitcoin wallets all agree on the same address down to the last character. If you reach this rung and still want to keep going, that itself is a sign you have become the kind of careful owner this tool is built for.',
    whyItWorks:
      'Everything on the higher rungs is a plain-language summary of these exact rules. Coming down here is how you verify for yourself that the summaries are true rather than taking anyone word for it -- the ultimate "do not trust, verify."',
    theCrypto:
      'BIP 341 tapscript sighash; BIP 340 Schnorr signatures; key-origin descriptors pk([fp/path]xpub/0/0), fixed at the /0/0 child rather than a /0/* wildcard range; x-only pubkeys at the leaf; the NUMS internal key; that /0/0 fixed-child parity is what makes Nunchuk/Sparrow imports agree on the exact same one address DynastyTrust does, rather than a range offering addresses the app has no spending logic for; rust-miniscript round-trip verification on compile. See THESIS.md, protocol/, and lib/psbt-signer.ts.',
    socraticQuestion:
      'Do you want to verify the machinery yourself, rather than trust that the plain-language summaries are accurate?',
    sourcePointers: ['THESIS.md', 'protocol/', 'apps/web/src/lib/psbt-signer.ts'],
  },
};
