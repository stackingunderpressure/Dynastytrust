/**
 * proposal-comments.js
 *
 * GET  /api/proposal-comments?proposal_id=<uuid>
 *        List comments + votes for a proposal (member-only).
 * POST /api/proposal-comments
 *        Body: { proposal_id, body?, vote? ('approve'|'abstain'|'decline') }
 *        At least one of body or vote required.
 *        If the caller already has a vote on this proposal, the
 *        new row supersedes the previous vote (the old row is
 *        kept for audit; UI dedupes to the latest per-member vote).
 * DELETE /api/proposal-comments?id=<uuid>
 *        Author or vault owner can delete.
 */

import { getSupabaseAdmin } from "./_supabase.js";
import { requireUser, json } from "./_auth.js";

const FIELDS = "id, created_at, proposal_id, user_id, body, vote";

export async function handler(event) {
  const u = await requireUser(event);
  if (u.error) return json(401, { error: u.error });

  const supabase = getSupabaseAdmin();

  if (event.httpMethod === "GET") {
    const proposalId = event.queryStringParameters?.proposal_id;
    if (!proposalId) return json(400, { error: "Missing: proposal_id" });

    const { data: proposal } = await supabase
      .from("proposals")
      .select("vault_id")
      .eq("id", proposalId)
      .maybeSingle();
    if (!proposal) return json(404, { error: "Proposal not found" });

    const { data: membership } = await supabase
      .from("vault_members")
      .select("id")
      .eq("vault_id", proposal.vault_id)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) return json(403, { error: "Not a member of this vault" });

    const { data, error } = await supabase
      .from("proposal_comments")
      .select(FIELDS)
      .eq("proposal_id", proposalId)
      .order("created_at", { ascending: true });
    if (error) return json(500, { error: error.message });

    return json(200, { ok: true, comments: data });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { proposal_id, body: text, vote } = body;
    if (!proposal_id) return json(400, { error: "Missing: proposal_id" });
    if (!text && !vote) return json(400, { error: "Provide a comment body, a vote, or both" });
    if (vote && !["approve", "abstain", "decline"].includes(vote)) {
      return json(400, { error: "Invalid vote" });
    }

    const { data: proposal } = await supabase
      .from("proposals")
      .select("vault_id")
      .eq("id", proposal_id)
      .maybeSingle();
    if (!proposal) return json(404, { error: "Proposal not found" });

    const { data: membership } = await supabase
      .from("vault_members")
      .select("id")
      .eq("vault_id", proposal.vault_id)
      .eq("user_id", u.userId)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) return json(403, { error: "Not a member of this vault" });

    const row = {
      proposal_id,
      user_id: u.userId,
      body: text ?? null,
      vote: vote ?? null,
    };

    const { data, error } = await supabase
      .from("proposal_comments")
      .insert(row)
      .select(FIELDS)
      .single();
    if (error) return json(500, { error: error.message });

    // Emit an event for the activity feed.
    await supabase.from("vault_events").insert({
      vault_id: proposal.vault_id,
      user_id: u.userId,
      event_type: vote ? `voted_${vote}` : "commented",
      metadata: { proposal_id, comment_id: data.id },
    });

    return json(201, { ok: true, comment: data });
  }

  if (event.httpMethod === "DELETE") {
    const id = event.queryStringParameters?.id;
    if (!id) return json(400, { error: "Missing query param: id" });

    const { data: comment } = await supabase
      .from("proposal_comments")
      .select("id, user_id, proposal_id")
      .eq("id", id)
      .maybeSingle();
    if (!comment) return json(404, { error: "Comment not found" });

    const isAuthor = comment.user_id === u.userId;
    let isOwner = false;
    if (!isAuthor) {
      const { data: proposal } = await supabase
        .from("proposals")
        .select("vault_id")
        .eq("id", comment.proposal_id)
        .maybeSingle();
      if (proposal) {
        const { data: vault } = await supabase
          .from("vaults")
          .select("id")
          .eq("id", proposal.vault_id)
          .eq("user_id", u.userId)
          .maybeSingle();
        isOwner = !!vault;
      }
    }
    if (!isAuthor && !isOwner) {
      return json(403, { error: "Only the author or the primary trustee can delete" });
    }

    const { error } = await supabase.from("proposal_comments").delete().eq("id", id);
    if (error) return json(500, { error: error.message });

    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
}
