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
 *   server-side from public/safe vault fields only, plus a strictly
 *   whitelisted readiness "eyes" digest (COUNTS and public labels
 *   ONLY -- never xpubs, pubkeys, or any secret). See the
 *   context-assembly comment and sanitizeEyes() below.
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

// ============================================================
// READINESS EYES -- strict allow-list sanitizer.
//
// The CLIENT (ChatWizard) assembles a small `eyes` object from data
// it already holds locally -- COUNTS derived from the keystore and
// a thin per-vault label list. This function is the server-side
// guard: it trusts NOTHING in body.eyes and rebuilds a clean digest
// from a fixed allow-list, mirroring the VAULT_SAFE_FIELDS
// discipline. Anything not named here is dropped on the floor, so a
// future client change cannot leak a new field into the model.
//
// The ONLY things that may pass:
//   - key_count, secure_key_count, test_key_count, backed_up_key_count
//     (non-negative integer counts, each capped)
//   - vault_count (non-negative integer count, capped)
//   - vaults: array (length-capped) of { name, template, network }
//     where name is a length-capped string, template is a
//     length-capped string or null, and network is ONLY one of the
//     three known labels (anything else -> null)
//
// There is no path here for an xpub, a pubkey, a fingerprint, a
// mnemonic, an encrypted blob, or a password -- those field names
// are never read. Counts and labels only.
// ============================================================
const EYES_MAX_VAULTS = 25;
const EYES_MAX_STR = 80;
const EYES_MAX_COUNT = 100000;
const EYES_NETWORKS = new Set(["testnet", "signet", "bitcoin", "mainnet"]);

function safeCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), EYES_MAX_COUNT);
}

function safeLabel(v, max) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function sanitizeEyes(raw) {
  if (!raw || typeof raw !== "object") return null;

  const keys = raw.keys && typeof raw.keys === "object" ? raw.keys : {};
  const digest = {
    key_count: safeCount(keys.key_count),
    secure_key_count: safeCount(keys.secure_key_count),
    test_key_count: safeCount(keys.test_key_count),
    backed_up_key_count: safeCount(keys.backed_up_key_count),
    vault_count: safeCount(raw.vault_count),
    vaults: [],
  };

  if (Array.isArray(raw.vaults)) {
    for (const v of raw.vaults.slice(0, EYES_MAX_VAULTS)) {
      if (!v || typeof v !== "object") continue;
      const name = safeLabel(v.name, EYES_MAX_STR);
      const template = safeLabel(v.template, EYES_MAX_STR);
      const networkLabel = safeLabel(v.network, EYES_MAX_STR);
      const network = networkLabel && EYES_NETWORKS.has(networkLabel)
        ? networkLabel
        : null;
      digest.vaults.push({
        name: name || "(unnamed)",
        template: template, // may be null -- a template-less / custom vault
        network,
      });
    }
  }

  return digest;
}

// Render the sanitized eyes digest into a clearly-labeled prompt
// section. Counts and labels only -- this text NEVER contains key
// material because sanitizeEyes() cannot produce any.
function buildEyesContext(eyes) {
  if (!eyes) return "";
  const vaultLines = eyes.vaults.length
    ? eyes.vaults
        .map((v) => {
          const tmpl = v.template ? v.template : "custom/none";
          const net = v.network ? v.network : "unspecified";
          return `  - "${v.name}" (template: ${tmpl}, network: ${net})`;
        })
        .join("\n")
    : "  (none yet)";

  return `
WHAT YOU CAN SEE ABOUT THIS PERSON'S SETUP (safe readiness only -- counts and labels, NEVER keys):
keys set up: ${eyes.key_count} total (${eyes.secure_key_count} secured with a password, ${eyes.test_key_count} test/practice, ${eyes.backed_up_key_count} backed up)
vaults already built: ${eyes.vault_count}
${vaultLines}

Use this to GROUND your guidance in what they actually have. Examples: if a
plan needs 3 founder keys and they have 2 keys, tell them they will make one
more in the next step; if they have zero keys, gently start there; if they
already built a vault, acknowledge it instead of starting from scratch. NEVER
assume more than these counts and labels show. These are COUNTS and LABELS only
-- you cannot see and must never ask for or repeat any seed words, private
keys, xpubs, or passwords. Having a count is not having a key.`;
}

function modeClause(mode) {
  if (mode === "express") {
    return `
CONVERSATION MODE: EXPRESS.
Move fast. Ask only the fewest questions you genuinely need to recommend a fit
-- typically who holds keys and who should inherit or recover. Skip the long
teaching detours; keep explanations to a sentence or two. As soon as the basics
are clear, PROPOSE a vault with the proposal block. Bias toward proposing
sooner rather than later, while staying inside every rail.`;
  }
  return `
CONVERSATION MODE: GUIDED.
Go one question at a time and teach as you go. After each answer, reflect it
back in plain words and add one small piece of understanding before asking the
next question. Do NOT propose a vault until the whole picture is clear (who
holds keys, who inherits or recovers, and roughly when). Patience over speed;
the learning is the point.`;
}

function buildSystemPrompt(vaultContext, eyesContext, mode) {
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
${modeClause(mode)}
${eyesContext}
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

  // Readiness eyes: client-assembled, server-sanitized. We NEVER trust
  // the raw shape -- sanitizeEyes rebuilds a clean counts-and-labels
  // digest from a fixed allow-list and discards everything else. The
  // raw value is never logged. (Eyes are request-time only; they are
  // NEVER persisted to assistant_threads.)
  const eyes = sanitizeEyes(body.eyes);

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
    // everything except the typed message + mode + ids + the readiness
    // eyes -- and even the eyes are run through sanitizeEyes(), which
    // rebuilds a counts-and-labels-only digest from a fixed allow-list
    // and cannot emit an xpub, pubkey, fingerprint, mnemonic, encrypted
    // blob, or password. Raw eyes are never logged.
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
      system: buildSystemPrompt(vaultContext, buildEyesContext(eyes), mode),
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
