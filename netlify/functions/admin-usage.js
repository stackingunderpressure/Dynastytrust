/**
 * admin-usage.js -- admin-only Sage token-usage report.
 *
 * GET or POST /api/admin-usage
 *   -> 401 if no/invalid JWT
 *   -> 403 if the caller's email is not in the ADMIN_EMAILS allow-list
 *      (deny by default: an unset/empty ADMIN_EMAILS denies everyone)
 *   -> 200 { totals, byModel, byDay, estimatedCostUsd, generatedAt }
 *
 * SECURITY RAIL -- READ THIS:
 *   The admin gate is enforced SERVER-SIDE here, decided from the
 *   VERIFIED JWT. The browser may hide the UI, but authorization is
 *   never trusted from the client. Cross-user aggregation needs the
 *   service-role client (RLS blocks cross-user reads); that client is
 *   used ONLY after the admin check passes. The response carries
 *   aggregate token counts and an estimated cost ONLY -- never message
 *   content, never any per-user PII, never key material.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

// Per-model LIST prices in USD per 1,000,000 tokens. A model not in
// this map returns its token counts but a null/unknown cost rather
// than a guessed number. Update when Anthropic's list prices change.
const PRICING = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
};

// Cache pricing is expressed as a multiple of the model's INPUT rate.
// Cache reads are cheap (~0.1x input); writing/creating cache costs a
// premium (~1.25x input). These are folded into the estimate
// approximately; the authoritative bill is at console.anthropic.com.
const CACHE_READ_MULT = 0.1;
const CACHE_CREATE_MULT = 1.25;

const PER_MILLION = 1_000_000;

// Parse the comma-separated allow-list from env. Trimmed, lowercased,
// empties dropped. Unset/empty -> empty set -> deny everyone.
function adminEmailSet() {
  const raw = process.env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

// Estimated USD cost for one model's token totals. Returns a number,
// or null when the model is not in the PRICING map (cost unknown --
// we never guess). Cache tokens are folded in as multiples of input.
function estimateModelCost(model, t) {
  const p = PRICING[model];
  if (!p) return null;
  const usd =
    (t.input_tokens * p.input +
      t.output_tokens * p.output +
      t.cache_read_tokens * p.input * CACHE_READ_MULT +
      t.cache_creation_tokens * p.input * CACHE_CREATE_MULT) /
    PER_MILLION;
  return usd;
}

function zeroTotals() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

function addInto(acc, row) {
  acc.input_tokens += toInt(row.input_tokens);
  acc.output_tokens += toInt(row.output_tokens);
  acc.cache_read_tokens += toInt(row.cache_read_tokens);
  acc.cache_creation_tokens += toInt(row.cache_creation_tokens);
}

function toInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export async function handler(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  // 1) Authenticate -- 401 on any failure.
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  // 2) Determine the caller's email. Prefer the verified JWT claim;
  //    fall back to a service-role lookup by user id. Either way the
  //    decision is made server-side, never trusted from the client.
  let email = null;
  const claimEmail = u.claims && typeof u.claims.email === "string" ? u.claims.email : null;
  if (claimEmail) {
    email = claimEmail;
  } else {
    try {
      const { data } = await supabase.auth.admin.getUserById(u.userId);
      if (data && data.user && typeof data.user.email === "string") {
        email = data.user.email;
      }
    } catch {
      email = null;
    }
  }

  // 3) Admin gate -- deny by default. Empty allow-list denies everyone.
  const allow = adminEmailSet();
  const normalized = email ? email.trim().toLowerCase() : null;
  if (allow.size === 0 || !normalized || !allow.has(normalized)) {
    return json(403, { error: "Forbidden" });
  }

  // 4) Aggregate via the service role (only now, after the gate).
  try {
    const { data, error } = await supabase
      .from("assistant_usage")
      .select(
        "model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(50000);

    if (error) return json(500, { error: "Could not load usage" });

    const rows = Array.isArray(data) ? data : [];

    const totals = zeroTotals();
    const byModelMap = new Map();
    const byDayMap = new Map();

    // Per-day window: roughly the last 30 days.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const row of rows) {
      addInto(totals, row);

      const model = typeof row.model === "string" && row.model ? row.model : "unknown";
      if (!byModelMap.has(model)) byModelMap.set(model, zeroTotals());
      addInto(byModelMap.get(model), row);

      const created = Date.parse(row.created_at);
      if (Number.isFinite(created) && created >= cutoff) {
        // YYYY-MM-DD in UTC.
        const day = new Date(created).toISOString().slice(0, 10);
        if (!byDayMap.has(day)) byDayMap.set(day, zeroTotals());
        addInto(byDayMap.get(day), row);
      }
    }

    const byModel = Array.from(byModelMap.entries())
      .map(([model, t]) => ({
        model,
        ...t,
        estimatedCostUsd: estimateModelCost(model, t),
      }))
      .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));

    // Total estimated cost = sum of priced models only. Unknown-cost
    // models contribute null and are excluded from the dollar total.
    let estimatedCostUsd = 0;
    for (const m of byModel) {
      if (typeof m.estimatedCostUsd === "number") estimatedCostUsd += m.estimatedCostUsd;
    }

    const byDay = Array.from(byDayMap.entries())
      .map(([day, t]) => ({ day, ...t }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

    return json(200, {
      ok: true,
      totals,
      byModel,
      byDay,
      estimatedCostUsd,
      callCount: rows.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg =
      err instanceof Error && err.message ? err.message : "Usage report failed";
    return json(500, { error: msg });
  }
}
