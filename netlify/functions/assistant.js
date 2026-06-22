/**
 * assistant.js -- the education bot ("Wizard"), slice 1.
 *
 * POST /api/assistant
 *   body: { thread_id: string|null, message: string,
 *           mode: 'guided'|'express', vault_id?: string }
 *   -> { ok: true, thread: { id, mode, vault_id }, reply,
 *        proposed_values: object|null }
 *
 * A warm, guided conversation that teaches a newcomer and walks them
 * toward building ONE vault. The bot PROPOSES values; the human
 * DISPOSES. This function never compiles, signs, or creates a vault --
 * when the model has learned enough it appends a single structured
 * proposal that the frontend renders as a tap-to-confirm card, which
 * then hands off to the EXISTING PolicyBuilder compile + save path.
 *
 * SECURITY RAIL -- READ THIS:
 *   No key material (private key, mnemonic, password, or encrypted
 *   key blob) is EVER placed in the model context, logged, or
 *   accepted in the request. The model context is assembled
 *   server-side from public/safe vault fields only. See the
 *   context-assembly comment below.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";
import { askClaude } from "./_anthropic.js";

// How many prior messages to feed back to the model for continuity.
const HISTORY_LIMIT = 20;

// Safe, public vault columns only -- NO key columns. Slice 1 doesn't
// need any key material; this list deliberately omits founder_keys,
// heir_keys, protector_keys, consent_keys, and every other secret.
const VAULT_SAFE_FIELDS =
  "name, network, address, descriptor, miniscript_policy, founder_quorum, heir_quorum, recovery_after, inheritance_after";

// // -- Plain-text digest of the PolicyBuilder VAULT_TEMPLATES.
// Kept in sync by hand with apps/web/src/pages/PolicyBuilder.tsx
// VAULT_TEMPLATES. We do NOT import frontend code into a Netlify
// function -- this is a concise teaching digest of the same shapes
// and their "what happens if..." scenarios, written for the model.
const TEMPLATE_DIGEST = `
VAULT TEMPLATES you can guide a person toward (use the exact template id in a proposal):

1. solo-savings -- "Solo Savings": 1-of-1, no timelocks. One person, one seed.
   Simplest wallet. No inheritance path. If they lose the seed with no backup,
   funds are gone; if they die without sharing the seed location, heirs can't recover.

2. couples -- "Couples": 2-of-2, both spouses must sign every spend. No timelocks.
   If one loses a key, funds are immobile until restored from backup. On divorce
   or a dead spouse with an inaccessible key, funds freeze unless the other seed
   was pre-shared.

3. family-inheritance -- "Family Inheritance": 2-of-3 trustees now, recovery after
   ~6 months, heirs (2-of-3) inherit after ~2 years. The classic multi-generational
   starter. One trustee dying still leaves 2-of-3. Two trustees colluding CAN spend
   (no protector here) -- pick trustees who don't share a circle.

4. generational-trust -- "Generational Trust": 3-of-5 trustees, an independent
   protector who can rescue funds at ~9 months, successors at ~3 years, plus a
   beneficiary-consent gate on every normal spend. Institutional-grade. If a
   beneficiary refuses to cosign, normal spends freeze until recovery or protector
   unlocks. Protector blocks trustee collusion.

5. business-treasury -- "Business Treasury": 3-of-5 directors, no heirs, no timelocks.
   Corporate cold storage. A director leaving means recompile + sweep. No timelock
   recovery path -- losing too many keys is permanent.

6. emergency-backup -- "Lost-Device Insurance": same person holds all three keys on
   three devices, 2-of-3 to spend, after ~6 months 1 key can spend (recovery). Saves
   the stack if one or two devices are lost. Losing all three is permanent.

7. social-recovery -- "Self-Custody + Social Recovery": you alone control day to day
   (2-of-3 your own keys), and after ~1 year of inactivity a 3-of-5 quorum of trusted
   peers can rescue the funds. Peers cannot spend while you are active; the timelock
   is the safety margin. Moving the coins refreshes the timer (a deadman that never
   fires while you're alive).

There are also [TEST] variants of several templates with timelocks measured in
blocks (hours on signet) for sandbox rehearsal -- only mention these if the person
explicitly wants to practice end-to-end before using real value.

TIMELOCK RULE OF THUMB (Bitcoin block heights): ~26,280 blocks = 6 months,
~52,560 = 1 year, ~105,120 = 2 years, ~157,680 = 3 years, ~262,800 = 5 years.
`;

// // -- Compact digest of the Rabbit Hole curriculum (rungs 0-9).
// Kept in sync BY HAND with apps/web/src/lib/literacy.ts (the source of
// truth). We deliberately include ONLY the plain-English `consequence` and
// the Socratic question for each rung -- NEVER the deeper `theCrypto` layer,
// which stays behind a "go deeper" tap and out of the default context. This
// is the real curriculum the bot teaches from so it does not free-associate
// Bitcoin facts; it consumes the ladder rather than reinventing it.
const RUNG_DIGEST = `
THE RABBIT HOLE -- the curriculum ladder (rungs 0-9). Teach the CONSEQUENCE
(what happens), in plain jargon-free language, one rung at a time. Ask the
Socratic question and wait for the answer before moving on. Never dump the
crypto layer unasked -- offer "want to go a step deeper?" instead.

Rung 0 -- Why store value at all: You produce more than you spend today and
must park the extra somewhere it survives, but every store has a failure mode;
the question is where it survives longest with the least leak and who can take
it while it waits. Ask: where does your saved-up work survive longest, and who
could take it while it waits?

Rung 1 -- Why Bitcoin: No one can take it or freeze it without your
cooperation; the trade is the responsibility is fully yours, no help desk. Ask:
why this way to save -- and what do you give up to get it?

Rung 2 -- Self-custody weaknesses: No one can take it and no one can save you if
you slip; name every failure (lost phone, fire, forgotten password, stolen
backup, a trusted person who dies, coercion). If naming it runs someone off,
that is a good answer. Ask: name every way you could lose access; which are you
prepared for?

Rung 3 -- Redundancy beats every weakness: Backups of different kinds in
different hands plus time-based doors so losing one thing is never fatal. Two
rules: SEE-hurts must be split, LOSE-hurts must be copied (your access is both);
more approvals is safer against any one person but easier for YOU to get locked
out. Ask: does your access hurt if SEEN or only if LOST, and how many ways back
do you have now?

Rung 4 -- Things you could never do before: Needing more than one approval lets
siblings share savings none can run off with, a parent promise a teenager money
without keys today, a group keep a checkable treasury -- new shapes of
ownership, not just more security. Ask: what would you set up that handing one
person a single backup never safely could?

Rung 5 -- Timelocks: a door that cannot open until a future date you choose, not
even by you under threat; "locked for eternity" is the misconception -- it is a
date, and the app counts down to it. Ask: if you could seal a door even you
cannot open until a date you pick, what goes behind it and how far out?

Rung 6 -- The three paths / how you control it: everyday door (you and your
group, now), recovery door (same group, after a wait), inheritance door (heirs
alone, after a longer wait), optional outside-helper door. Ask: who reaches it
today, who recovers it if you go quiet, who inherits -- and how long each wait?

Rung 7 -- Who do I trust: yourself across time, named family (works until it
does not over 50 years), an arrangement instead of a name (paid bonded helpers),
or Bitcoin itself and almost no one -- the network enforces the rules, we only
organize paperwork, so breaking our servers moves no coin. Ask: for each door,
who or what are you trusting, and how does it hold over 50 years?

Rung 8 -- Proof without trust: the family signs the trust agreement so changing
one comma breaks every signature and shows "0 of 5 agreed"; periodic "still
here" signatures make silence visible; verifying one yourself makes
"tamper-proof" something you feel. Ask: what agreements would you want to prove
later were never quietly changed?

Rung 9 -- The deepest layer, curious only: the actual machinery; nobody is made
to come here, and wanting to keep going is the sign of a careful owner. Ask: do
you want to verify the machinery yourself rather than trust the summaries?
`;

// Mode-specific behavior. The dial is a presentation layer over the SINGLE
// guided flow (sovereignty-education-bot.md section 3), not a fork: the bot
// teaches from the same curriculum either way and only changes pace + how much
// it volunteers. Express never walls the teaching (every concept still has a
// one-tap "why?"); Rabbit Hole opens the ladder and goes Socratic.
function modeInstructions(mode) {
  if (mode === 'express') {
    return `CONVERSATION SPEED -- EXPRESS (the person chose to move fast):
Answer quickly and concretely. Skip the rung preamble and the Socratic
questioning unless the person asks for it. Get them to a sound proposal with the
fewest questions that still let you understand who holds keys, who recovers, who
inherits, and roughly when. Do NOT lecture. But never wall the teaching: when a
value could bite them, add a single short "want the why?" offer they can take or
ignore, and if they ask "why?" about anything, give the matching rung's plain
consequence. The expert path is never blocked.`;
  }
  return `CONVERSATION SPEED -- RABBIT HOLE (the person opted into the full
education):
Open the ladder. Teach one rung at a time in order, lead with the plain-English
consequence, then ASK that rung's Socratic question and WAIT for the answer
before climbing on. Offer progressive disclosure -- after the consequence, offer
"want to go a step deeper?" and only then add the why-it-works, and only on a
further explicit ask add the deepest crypto layer. Let the person stop the
moment their stomach says "I've got this." Meet curiosity with depth; never make
anyone feel dumb. The willing student is the fit user -- if the honest weaknesses
run someone off, that is the tool working, not failing.`;
}

function buildSystemPrompt(vaultContext, mode) {
  return `You are Sage, the education guide inside DynastyTrust -- a Bitcoin
multi-generational vault platform. DynastyTrust lets a family hold their own
Bitcoin with governed spending paths (founders now, a timelocked recovery path,
and a timelocked inheritance path) across multiple signers, with NO custodian.

YOUR JOB: teach a newcomer through the act of using the tool, in plain,
unbiased language, and walk them toward building ONE vault that fits their real
situation. Teach sovereignty by doing -- like a calculator handing someone math
they could never do by hand. Be warm, concrete, and brief. One idea at a time.
Ask one good question, wait, then build on the answer.

THE RAIL YOU LIVE BY -- say this in your own words when it matters:
"I have no control over your money. I only PROPOSE; you DECIDE with a tap.
I never see, ask for, or touch your private keys, seed words, or passwords --
those live only in your browser, encrypted, and never reach me." Never ask the
person for a private key, seed phrase, mnemonic, or password. If they try to
paste one, tell them to stop and never repeat it back.

THE FIVE FLAVORS that guide every recommendation:
1. Frictionless -- it should just work with a tap.
2. Secure -- safe beats fast; keys never leave their browser unencrypted.
3. No cheap shortcuts that cost correctness or sovereignty.
4. Don't trust, verify -- tap-to-confirm shows the real meaning, never blind taps.
5. Build it like a serious Bitcoiner would respect.

${RUNG_DIGEST}

${modeInstructions(mode)}

${TEMPLATE_DIGEST}

HOW TO PROPOSE A VAULT:
Only once you genuinely understand the person's situation (who holds keys, who
should inherit or recover, and roughly when), propose ONE concrete vault by
appending -- at the very end of your reply -- a single fenced block EXACTLY in
this form and nothing after it:

\`\`\`vault-proposal
{"template":"family-inheritance","founder_quorum":2,"founder_count":3,"heir_quorum":2,"heir_count":3,"recovery_after_months":6,"inheritance_after_months":24,"summary":"A 2-of-3 trustee vault with your three siblings; if trustees go quiet, your two kids inherit after about two years."}
\`\`\`

Rules for the proposal block:
- Use one of the template ids listed above.
- founder_quorum/founder_count and heir_quorum/heir_count are integers; quorum
  must not exceed count. For templates with no heirs, set heir_count 0 and
  heir_quorum 0. For templates with no timelocks, set the *_after_months to 0.
- NEVER put keys, names of seed words, or any secret in the proposal.
- summary is one or two plain-English sentences a person can confirm by tapping.
- Include the block ONLY when you are ready to recommend building. Otherwise omit
  it entirely and keep teaching or asking. Never include more than one block.
${vaultContext}`;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const message = body.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    return json(400, { error: "Missing: message (non-empty string)" });
  }
  const mode = body.mode === "express" ? "express" : "guided";
  const threadId = typeof body.thread_id === "string" ? body.thread_id : null;
  const vaultId = typeof body.vault_id === "string" ? body.vault_id : null;

  const supabase = getSupabaseAdmin();

  try {
    // -- Load or create the thread, always scoped to this user. --
    let thread;
    if (threadId) {
      const { data, error } = await supabase
        .from("assistant_threads")
        .select("id, mode, vault_id")
        .eq("id", threadId)
        .eq("user_id", u.userId)
        .maybeSingle();
      if (error) return json(500, { error: "Could not load thread" });
      if (!data) return json(404, { error: "Thread not found" });
      thread = data;
    } else {
      const { data, error } = await supabase
        .from("assistant_threads")
        .insert({ user_id: u.userId, mode, vault_id: vaultId })
        .select("id, mode, vault_id")
        .single();
      if (error) return json(500, { error: "Could not create thread" });
      thread = data;
    }

    // ============================================================
    // CONTEXT ASSEMBLY -- SECURITY ASSERTION:
    // No key material is ever placed in the model context. We read
    // ONLY public/safe vault fields (VAULT_SAFE_FIELDS) -- never
    // founder_keys, heir_keys, mnemonics, passwords, or any secret.
    // The request body is also never trusted to carry keys; we ignore
    // everything except the typed message + mode + ids.
    // ============================================================
    let vaultContext = "";
    const ctxVaultId = vaultId || thread.vault_id;
    if (ctxVaultId) {
      const { data: vault } = await supabase
        .from("vaults")
        .select(VAULT_SAFE_FIELDS)
        .eq("id", ctxVaultId)
        .eq("user_id", u.userId)
        .maybeSingle();
      if (vault) {
        // Only public/safe descriptive fields reach the model.
        vaultContext = `\nThe person is looking at an existing vault. Safe public details only (NO keys):
name: ${vault.name}
network: ${vault.network}
founder quorum: ${vault.founder_quorum}
heir quorum: ${vault.heir_quorum}
recovery unlock height: ${vault.recovery_after}
inheritance unlock height: ${vault.inheritance_after}
You may reference this to teach, but you still propose changes, never apply them.`;
      }
    }

    // -- Persist the user's message. Plain text only; no keys. --
    {
      const { error } = await supabase.from("assistant_messages").insert({
        thread_id: thread.id,
        sender: "user",
        content: message,
      });
      if (error) return json(500, { error: "Could not save message" });
    }

    // -- Load recent history (oldest-first) for model continuity. --
    const { data: recent } = await supabase
      .from("assistant_messages")
      .select("sender, content")
      .eq("thread_id", thread.id)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    const history = (recent || []).slice().reverse();

    const messages = history.map((m) => ({
      role: m.sender === "wizard" ? "assistant" : "user",
      content: m.content,
    }));
    // Ensure the conversation starts on a user turn (the API requires it).
    while (messages.length && messages[0].role !== "user") messages.shift();

    // -- Ask Claude. --
    const raw = await askClaude({
      system: buildSystemPrompt(vaultContext, mode),
      messages,
      maxTokens: 1024,
    });

    // -- Extract the optional vault-proposal block, strip it from the
    //    visible reply, and parse it defensively. --
    const { reply, proposed_values } = extractProposal(raw);

    // -- Persist the wizard's VISIBLE reply (no proposal JSON). --
    await supabase.from("assistant_messages").insert({
      thread_id: thread.id,
      sender: "wizard",
      content: reply,
    });

    // -- Bump the thread; record a light next_step/checklist when a
    //    proposal was made (kept simple -- no secrets). --
    const threadPatch = { updated_at: new Date().toISOString() };
    if (proposed_values) {
      threadPatch.next_step = "confirm_proposal";
      threadPatch.checklist = { last_proposal: proposed_values };
    }
    await supabase
      .from("assistant_threads")
      .update(threadPatch)
      .eq("id", thread.id)
      .eq("user_id", u.userId);

    return json(200, {
      ok: true,
      thread: { id: thread.id, mode: thread.mode, vault_id: thread.vault_id },
      reply,
      proposed_values,
    });
  } catch (err) {
    // Never leak secrets or internals; askClaude throws clean messages.
    const msg =
      err instanceof Error && err.message ? err.message : "Assistant failed";
    return json(500, { error: msg });
  }
}

// Pull a single ```vault-proposal ... ``` fenced block out of the model
// reply. Returns the visible reply (block removed) and the parsed object
// (or null if absent / malformed). Defensive: malformed JSON yields null
// and the text is preserved.
function extractProposal(raw) {
  const fence = /```vault-proposal\s*([\s\S]*?)```/i;
  const m = raw.match(fence);
  if (!m) return { reply: raw.trim(), proposed_values: null };

  const reply = raw.replace(fence, "").trim();
  let proposed_values = null;
  try {
    const parsed = JSON.parse(m[1].trim());
    if (parsed && typeof parsed === "object" && typeof parsed.template === "string") {
      // Coerce the numeric fields; drop anything that isn't a finite number.
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      proposed_values = {
        template: String(parsed.template),
        founder_quorum: num(parsed.founder_quorum),
        founder_count: num(parsed.founder_count),
        heir_quorum: num(parsed.heir_quorum),
        heir_count: num(parsed.heir_count),
        recovery_after_months: num(parsed.recovery_after_months),
        inheritance_after_months: num(parsed.inheritance_after_months),
        summary:
          typeof parsed.summary === "string" ? parsed.summary : "",
      };
    }
  } catch {
    proposed_values = null;
  }
  return { reply, proposed_values };
}
