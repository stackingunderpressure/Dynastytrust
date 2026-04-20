/**
 * GET /api/vault-audit-pdf?id=<vault-uuid>
 *
 * Full attorney-review audit trail for a vault: trust document,
 * member roster, every proposal (with signatures + comments), every
 * distribution request (with resolutions), every scheduled stipend,
 * every distribution wallet tranche, and the chronological events
 * log. Unlike vault-pdf.js (client-facing summary), this is the
 * long-form export intended for legal / tax review.
 *
 * Auto-paginates — the page wraps when y falls below the footer
 * reservation and resumes on a fresh page with the same header.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { requireUser } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';

const GOLD      = rgb(0.788, 0.659, 0.298);
const GOLD_DIM  = rgb(0.545, 0.412, 0.078);
const DARK      = rgb(0.039, 0.039, 0.059);
const SURFACE   = rgb(0.086, 0.086, 0.133);
const TEXT      = rgb(0.910, 0.894, 0.847);
const TEXT_DIM  = rgb(0.600, 0.580, 0.659);
const TEXT_MUTE = rgb(0.353, 0.333, 0.439);
const WHITE     = rgb(1, 1, 1);
const ORANGE    = rgb(0.878, 0.565, 0.314);
const GREEN     = rgb(0.322, 0.769, 0.478);
const RED       = rgb(0.878, 0.361, 0.361);

const W = 595.28;
const H = 841.89;
const M = 48;
const FOOTER_Y = 48;

function fmtDate(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    }) + ' UTC';
  } catch { return String(ts); }
}

function satsToBtc(sats) {
  if (sats == null) return '-';
  return (Number(sats) / 1e8).toFixed(8).replace(/\.?0+$/, '') || '0';
}

function wrap(str, maxChars) {
  if (!str) return ['-'];
  const words = String(str).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

function wrapMono(str, maxChars) {
  if (!str) return ['-'];
  const lines = [];
  for (let i = 0; i < str.length; i += maxChars) {
    lines.push(str.slice(i, i + maxChars));
  }
  return lines;
}

async function buildAuditPdf(data) {
  const { vault, trustDoc, members, invites, proposals, signerSessions,
          comments, requests, stipends, distributionWallets, events,
          attestations } = data;

  const doc = await PDFDocument.create();
  doc.setTitle(`DynastyTrust Audit -- ${vault.name}`);
  doc.setAuthor('DynastyTrust');
  doc.setCreator('DynastyTrust Platform');
  doc.setCreationDate(new Date());

  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg  = await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.Courier);

  let page = null;
  let y = 0;
  let pageNum = 0;
  const now = new Date();

  function header(p) {
    p.drawRectangle({ x: 0, y: H - 60, width: W, height: 60, color: DARK });
    p.drawRectangle({ x: 0, y: H - 62, width: W, height: 2, color: GOLD });
    p.drawText('DYNASTYTRUST AUDIT TRAIL', {
      x: M, y: H - 36, size: 14, font: bold, color: GOLD,
    });
    p.drawText(vault.name || 'Unnamed Vault', {
      x: M, y: H - 52, size: 9, font: reg, color: TEXT_DIM,
    });
    const nowStr = fmtDate(now);
    const tw = reg.widthOfTextAtSize(nowStr, 8);
    p.drawText(nowStr, { x: W - M - tw, y: H - 36, size: 8, font: reg, color: TEXT_DIM });
  }

  function footer(p) {
    p.drawRectangle({ x: 0, y: 0, width: W, height: 32, color: DARK });
    p.drawRectangle({ x: 0, y: 32, width: W, height: 0.5, color: GOLD_DIM, opacity: 0.4 });
    p.drawText('DynastyTrust -- Attorney-review audit trail', {
      x: M, y: 12, size: 8, font: reg, color: TEXT_MUTE,
    });
    const pageStr = `Page ${pageNum}`;
    const pw = reg.widthOfTextAtSize(pageStr, 8);
    p.drawText(pageStr, { x: W - M - pw, y: 12, size: 8, font: reg, color: TEXT_MUTE });
  }

  function newPage() {
    if (page) footer(page);
    page = doc.addPage([W, H]);
    pageNum++;
    header(page);
    y = H - 76;
  }

  function ensureSpace(needed) {
    if (y - needed < FOOTER_Y) {
      newPage();
    }
  }

  function sectionHeader(title) {
    ensureSpace(42);
    page.drawText(title, { x: M, y, size: 11, font: bold, color: GOLD });
    y -= 8;
    page.drawLine({
      start: { x: M, y }, end: { x: W - M, y },
      thickness: 0.5, color: GOLD_DIM, opacity: 0.5,
    });
    y -= 18;
  }

  function line(text, options = {}) {
    const {
      size = 9, font = reg, color = TEXT_DIM, indent = 0, gap = 14,
    } = options;
    ensureSpace(gap);
    page.drawText(String(text ?? '-'), {
      x: M + indent, y, size, font, color, maxWidth: W - M * 2 - indent,
    });
    y -= gap;
  }

  function wrapped(text, options = {}) {
    const { size = 9, font = reg, color = TEXT_DIM, indent = 0, maxChars = 100 } = options;
    for (const l of wrap(text, maxChars)) {
      ensureSpace(13);
      page.drawText(l, {
        x: M + indent, y, size, font, color, maxWidth: W - M * 2 - indent,
      });
      y -= 13;
    }
  }

  function keyValue(k, v, options = {}) {
    const { valueMono = false } = options;
    ensureSpace(14);
    page.drawText(k, { x: M, y, size: 8, font: bold, color: TEXT_MUTE });
    page.drawText(String(v ?? '-'), {
      x: M + 140, y, size: 9, font: valueMono ? mono : reg, color: TEXT,
      maxWidth: W - M * 2 - 140,
    });
    y -= 14;
  }

  // -- Page 1: cover + trust doc -------------------------------------------
  newPage();

  y -= 10;
  page.drawText(vault.name || 'Unnamed Vault', {
    x: M, y, size: 22, font: bold, color: WHITE,
  });
  y -= 22;
  page.drawText(
    `${(vault.network || 'testnet').toUpperCase()} . ${vault.status} . ${(vault.address_type || 'tr').toUpperCase()}`,
    { x: M, y, size: 10, font: reg, color: TEXT_DIM },
  );
  y -= 22;

  sectionHeader('VAULT SUMMARY');
  keyValue('Network', vault.network);
  keyValue('Status', vault.status);
  keyValue('Address type', vault.address_type);
  keyValue('Address', vault.address, { valueMono: true });
  keyValue('Founder quorum', `${vault.founder_quorum} of ${(vault.founder_keys || []).length}`);
  keyValue('Heir quorum', `${vault.heir_quorum} of ${(vault.heir_keys || []).length}`);
  if (vault.recovery_quorum != null) keyValue('Recovery quorum', `${vault.recovery_quorum} of ${(vault.founder_keys || []).length}`);
  keyValue('Recovery at block', (vault.recovery_after || 0).toLocaleString());
  keyValue('Inheritance at block', (vault.inheritance_after || 0).toLocaleString());
  if (vault.protector_after) keyValue('Protector at block', (vault.protector_after).toLocaleString());
  if (vault.consent_quorum != null) keyValue('Consent quorum', `${vault.consent_quorum} of ${(vault.consent_keys || []).length}`);
  keyValue('Compiled', fmtDate(vault.updated_at || vault.created_at));
  y -= 6;

  // -- Trust document
  sectionHeader('TRUST DOCUMENT');
  if (trustDoc?.purpose) {
    line('Purpose', { font: bold, color: GOLD, size: 9 });
    wrapped(trustDoc.purpose, { indent: 12 });
    y -= 4;
  }
  if (trustDoc?.beneficiaries?.length) {
    line('Beneficiaries', { font: bold, color: GOLD, size: 9 });
    for (const b of trustDoc.beneficiaries) {
      wrapped(`. ${b.name}${b.relation ? ` (${b.relation})` : ''}${b.notes ? ` -- ${b.notes}` : ''}`, { indent: 12 });
    }
    y -= 4;
  }
  if (trustDoc?.distribution_rules) {
    line('Distribution rules', { font: bold, color: GOLD, size: 9 });
    wrapped(trustDoc.distribution_rules, { indent: 12 });
    y -= 4;
  }
  if (trustDoc?.rules?.length) {
    line('Enforced rules', { font: bold, color: GOLD, size: 9 });
    for (const r of trustDoc.rules) {
      wrapped(
        `. ${r.name}${r.max_sats ? ` (max ${satsToBtc(r.max_sats)} BTC)` : ''}${r.requires_comment ? ' -- memo required' : ''}`,
        { indent: 12, font: bold, color: TEXT },
      );
      if (r.notes) wrapped(r.notes, { indent: 20 });
    }
    y -= 4;
  }
  if (trustDoc?.succession_notes) {
    line('Succession', { font: bold, color: GOLD, size: 9 });
    wrapped(trustDoc.succession_notes, { indent: 12 });
    y -= 4;
  }
  if (!trustDoc || (!trustDoc.purpose && !trustDoc.distribution_rules && !trustDoc.succession_notes)) {
    line('No trust document on file.', { color: TEXT_MUTE });
  }

  // -- Members --------------------------------------------------------------
  sectionHeader('MEMBER ROSTER');
  if (members.length === 0) {
    line('No members recorded.', { color: TEXT_MUTE });
  } else {
    for (const m of members) {
      const who = `${m.role.toUpperCase()} . ${m.label || '(unlabeled)'}${m.key_label ? ` [${m.key_label}]` : ''}`;
      line(who, { font: bold, color: TEXT, size: 9 });
      wrapped(`fingerprint: ${m.fingerprint || '-'}  .  status: ${m.status}  .  joined: ${fmtDate(m.created_at)}`, {
        indent: 12, size: 8, color: TEXT_MUTE,
      });
      if (m.xpub) {
        for (const l of wrapMono(m.xpub, 78)) line(l, { indent: 12, font: mono, size: 7.5, color: TEXT_MUTE, gap: 10 });
      }
      y -= 2;
    }
  }

  if (invites.length > 0) {
    sectionHeader('OUTSTANDING INVITES');
    for (const inv of invites) {
      line(`${inv.invited_role.toUpperCase()} . ${inv.invited_label || inv.invited_email || '(unlabeled)'}`, { font: bold, size: 9, color: TEXT });
      wrapped(`expires ${fmtDate(inv.expires_at)}  .  claimed: ${inv.claimed_at ? fmtDate(inv.claimed_at) : 'pending'}`, {
        indent: 12, size: 8, color: TEXT_MUTE,
      });
    }
  }

  // -- Proposals ------------------------------------------------------------
  sectionHeader('PROPOSALS');
  if (proposals.length === 0) {
    line('No proposals filed.', { color: TEXT_MUTE });
  } else {
    for (const p of proposals) {
      ensureSpace(36);
      const statusColor =
        p.status === 'broadcast' ? GREEN :
        p.status === 'cancelled' ? TEXT_MUTE :
        p.status === 'signed' ? GOLD : ORANGE;
      line(`${p.path.toUpperCase()} . ${satsToBtc(p.amount_sats)} BTC . ${p.status}`, {
        font: bold, size: 10, color: statusColor,
      });
      wrapped(`to ${p.destination || '-'}`, { indent: 12, font: mono, size: 8, color: TEXT });
      line(
        `filed ${fmtDate(p.created_at)}  .  fee ${satsToBtc(p.fee_sats)} BTC${p.txid ? `  .  txid ${p.txid.slice(0,10)}...${p.txid.slice(-6)}` : ''}`,
        { indent: 12, size: 8, color: TEXT_MUTE },
      );
      if (p.memo) {
        wrapped(`memo: ${p.memo}`, { indent: 12, size: 8, color: TEXT_DIM });
      }
      const sigs = signerSessions.filter(s => s.proposal_id === p.id);
      if (sigs.length > 0) {
        line('Signatures:', { indent: 12, font: bold, size: 8, color: TEXT });
        for (const s of sigs) {
          line(
            `. ${s.label || s.fingerprint || 'unlabeled'} -- ${s.signed ? `signed ${fmtDate(s.signed_at)}` : 'pending'}`,
            { indent: 20, size: 8, color: s.signed ? GREEN : TEXT_MUTE },
          );
        }
      }
      const cs = comments.filter(c => c.proposal_id === p.id);
      if (cs.length > 0) {
        line('Comments:', { indent: 12, font: bold, size: 8, color: TEXT });
        for (const c of cs) {
          const voteSuffix = c.vote ? ` [${c.vote.toUpperCase()}]` : '';
          wrapped(
            `. ${fmtDate(c.created_at)}${voteSuffix} -- ${c.body || '(no body)'}`,
            { indent: 20, size: 8, color: TEXT_DIM },
          );
        }
      }
      y -= 6;
    }
  }

  // -- Requests -------------------------------------------------------------
  sectionHeader('DISTRIBUTION REQUESTS');
  if (requests.length === 0) {
    line('No requests filed.', { color: TEXT_MUTE });
  } else {
    for (const r of requests) {
      const statusColor = r.status === 'approved' ? GREEN
        : r.status === 'declined' ? RED
        : r.status === 'fulfilled' ? GOLD : TEXT_DIM;
      line(
        `${satsToBtc(r.amount_sats)} BTC . ${r.status.toUpperCase()}${r.rule_name ? ` . ${r.rule_name}` : ''}`,
        { font: bold, size: 10, color: statusColor },
      );
      line(`filed ${fmtDate(r.created_at)}  .  recipient: ${r.recipient_name || '-'}`, {
        indent: 12, size: 8, color: TEXT_MUTE,
      });
      if (r.reason) wrapped(`reason: ${r.reason}`, { indent: 12, size: 8, color: TEXT_DIM });
      if (r.resolution_note) wrapped(`resolution: ${r.resolution_note}`, { indent: 12, size: 8, color: TEXT_DIM });
      if (r.resolved_at) line(`resolved ${fmtDate(r.resolved_at)}`, { indent: 12, size: 8, color: TEXT_MUTE });
      y -= 4;
    }
  }

  // -- Stipends -------------------------------------------------------------
  if (stipends.length > 0) {
    sectionHeader('SCHEDULED STIPENDS');
    for (const s of stipends) {
      line(
        `${s.name} . ${satsToBtc(s.amount_sats)} BTC . every ${s.interval_kind}${s.active ? '' : ' (paused)'}`,
        { font: bold, size: 10, color: s.active ? TEXT : TEXT_MUTE },
      );
      line(`next due ${fmtDate(s.next_due_at)}${s.last_proposed_at ? `  .  last fired ${fmtDate(s.last_proposed_at)}` : ''}`, {
        indent: 12, size: 8, color: TEXT_MUTE,
      });
      if (s.recipient_name) line(`recipient: ${s.recipient_name}`, { indent: 12, size: 8, color: TEXT_DIM });
      y -= 2;
    }
  }

  // -- Distribution wallets -------------------------------------------------
  if (distributionWallets.length > 0) {
    sectionHeader('DISTRIBUTION WALLETS (T-VESTING)');
    for (const w of distributionWallets) {
      const tranches = w.tranches || [];
      const total = tranches.reduce((n, t) => n + (t.amount_sats || 0), 0);
      line(`${w.name}${w.beneficiary_name ? ` -- ${w.beneficiary_name}` : ''}`, {
        font: bold, size: 10, color: TEXT,
      });
      line(
        `${tranches.length} tranches . ${satsToBtc(total)} BTC total . ${tranches.filter(t => t.claimed_txid).length} claimed`,
        { indent: 12, size: 8, color: TEXT_MUTE },
      );
      for (const t of tranches) {
        line(
          `tranche ${t.index + 1}: block ${t.unlock_block?.toLocaleString() ?? '-'} . ${satsToBtc(t.amount_sats)} BTC . ${t.claimed_txid ? 'claimed' : t.funded_txid ? 'funded' : 'pending'}`,
          { indent: 20, size: 8, color: t.claimed_txid ? GREEN : TEXT_DIM },
        );
      }
      y -= 4;
    }
  }

  // -- Signed attestations --------------------------------------------------
  sectionHeader('SIGNED ATTESTATIONS');
  if (!attestations || attestations.length === 0) {
    line('No attestations recorded.', { color: TEXT_MUTE });
  } else {
    const byType = {
      descriptor: attestations.filter(a => a.attestation_type === 'descriptor'),
      trust_doc: attestations.filter(a => a.attestation_type === 'trust_doc'),
      proof_of_life: attestations.filter(a => a.attestation_type === 'proof_of_life'),
      death_declaration: attestations.filter(a => a.attestation_type === 'death_declaration'),
    };
    const memberLabel = id => members.find(m => m.user_id === id)?.label || '(unknown)';

    if (byType.descriptor.length) {
      line('Descriptor attestations', { font: bold, size: 9, color: rgb(0.29, 0.565, 0.851) });
      for (const a of byType.descriptor) {
        line(
          `. ${memberLabel(a.user_id)} signed descriptor hash ${a.target_hash.slice(0, 12)}... on ${fmtDate(a.signed_at)}`,
          { indent: 12, size: 8, color: TEXT_DIM },
        );
      }
      y -= 4;
    }

    if (byType.trust_doc.length) {
      line('Trust doc attestations', { font: bold, size: 9, color: GOLD });
      for (const a of byType.trust_doc) {
        line(
          `. ${memberLabel(a.user_id)} signed hash ${a.target_hash.slice(0, 12)}... on ${fmtDate(a.signed_at)}`,
          { indent: 12, size: 8, color: TEXT_DIM },
        );
        line(
          `  sig ${a.signature.slice(0, 24)}...${a.signature.slice(-12)}`,
          { indent: 20, size: 7.5, font: mono, color: TEXT_MUTE, gap: 10 },
        );
      }
      y -= 4;
    }

    if (byType.proof_of_life.length) {
      line('Proof-of-life check-ins', { font: bold, size: 9, color: GREEN });
      for (const a of byType.proof_of_life) {
        const note = (a.target_data && a.target_data.note) || '';
        line(
          `. ${memberLabel(a.user_id)} at ${fmtDate(a.signed_at)}${note ? ` -- ${note}` : ''}`,
          { indent: 12, size: 8, color: TEXT_DIM },
        );
      }
      y -= 4;
    }

    if (byType.death_declaration.length) {
      line('Death declarations', { font: bold, size: 9, color: RED });
      const byHash = new Map();
      for (const a of byType.death_declaration) {
        const arr = byHash.get(a.target_hash) || [];
        arr.push(a);
        byHash.set(a.target_hash, arr);
      }
      for (const [hash, sigs] of byHash) {
        const first = sigs[0];
        const td = first.target_data || {};
        const subj = memberLabel(td.subject_user_id);
        line(
          `Subject: ${subj}  .  effective ${td.effective_date || '-'}  .  ${sigs.length} signature${sigs.length === 1 ? '' : 's'}`,
          { font: bold, size: 9, color: TEXT, indent: 12 },
        );
        line(`hash ${hash.slice(0, 16)}...`, { indent: 20, size: 7.5, font: mono, color: TEXT_MUTE, gap: 10 });
        if (td.notes) wrapped(`notes: ${td.notes}`, { indent: 20, size: 8, color: TEXT_DIM });
        for (const s of sigs) {
          line(
            `. ${memberLabel(s.user_id)} signed ${fmtDate(s.signed_at)}`,
            { indent: 20, size: 8, color: TEXT_DIM },
          );
        }
        y -= 4;
      }
    }
  }

  // -- Events log -----------------------------------------------------------
  sectionHeader('CHRONOLOGICAL EVENT LOG');
  if (events.length === 0) {
    line('No events recorded.', { color: TEXT_MUTE });
  } else {
    for (const e of events) {
      line(`${fmtDate(e.created_at)}  .  ${e.event_type}`, { size: 8, font: bold, color: TEXT, gap: 12 });
      const metaStr = e.metadata
        ? Object.entries(e.metadata).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`).join(' . ')
        : '';
      if (metaStr) wrapped(metaStr, { indent: 12, size: 7.5, color: TEXT_MUTE, maxChars: 120 });
    }
  }

  // -- Appendix: descriptor + policy ---------------------------------------
  sectionHeader('APPENDIX: DESCRIPTOR + POLICY');
  if (vault.descriptor) {
    line('Output descriptor', { font: bold, size: 8, color: TEXT });
    for (const l of wrapMono(vault.descriptor, 80)) {
      line(l, { indent: 12, font: mono, size: 7.5, color: TEXT, gap: 11 });
    }
    y -= 4;
  }
  if (vault.miniscript_policy) {
    line('Miniscript policy', { font: bold, size: 8, color: TEXT });
    for (const l of wrapMono(vault.miniscript_policy, 80)) {
      line(l, { indent: 12, font: mono, size: 7.5, color: TEXT, gap: 11 });
    }
  }

  if (page) footer(page);
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // The auth helper reads Authorization header or the `token` query
  // param (the client passes the JWT in the query since <a href> can't
  // send headers).
  const u = await requireUser(event);
  if (u.error) {
    return { statusCode: 401, body: JSON.stringify({ error: u.error }),
             headers: { 'content-type': 'application/json' } };
  }

  const id = event.queryStringParameters?.id;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing id' }),
             headers: { 'content-type': 'application/json' } };
  }

  const supabase = getSupabaseAdmin();

  // Caller must be an active member of the vault.
  const { data: mem } = await supabase
    .from('vault_members')
    .select('id')
    .eq('vault_id', id)
    .eq('user_id', u.userId)
    .eq('status', 'active')
    .maybeSingle();
  if (!mem) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not a member' }),
             headers: { 'content-type': 'application/json' } };
  }

  const [
    vaultRes, membersRes, invitesRes, proposalsRes,
    requestsRes, stipendsRes, walletsRes, eventsRes,
    attestationsRes,
  ] = await Promise.all([
    supabase.from('vaults').select('*').eq('id', id).single(),
    supabase.from('vault_members').select('*').eq('vault_id', id).order('created_at'),
    supabase.from('vault_invites').select('*').eq('vault_id', id).order('created_at'),
    supabase.from('proposals').select('*').eq('vault_id', id).order('created_at'),
    supabase.from('vault_requests').select('*').eq('vault_id', id).order('created_at'),
    supabase.from('scheduled_stipends').select('*').eq('vault_id', id).order('next_due_at'),
    supabase.from('distribution_wallets').select('*').eq('vault_id', id).order('created_at'),
    supabase.from('vault_events').select('*').eq('vault_id', id).order('created_at'),
    supabase.from('vault_attestations').select('*').eq('vault_id', id).order('signed_at'),
  ]);

  if (vaultRes.error || !vaultRes.data) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Vault not found' }),
             headers: { 'content-type': 'application/json' } };
  }

  const proposalIds = (proposalsRes.data ?? []).map(p => p.id);
  const [signerSessionsRes, commentsRes] = await Promise.all([
    proposalIds.length > 0
      ? supabase.from('signer_sessions').select('*').in('proposal_id', proposalIds).order('signed_at')
      : Promise.resolve({ data: [] }),
    proposalIds.length > 0
      ? supabase.from('proposal_comments').select('*').in('proposal_id', proposalIds).order('created_at')
      : Promise.resolve({ data: [] }),
  ]);

  try {
    const pdf = await buildAuditPdf({
      vault: vaultRes.data,
      trustDoc: vaultRes.data.trust_doc || {},
      members: membersRes.data ?? [],
      invites: (invitesRes.data ?? []).filter(i => !i.claimed_at),
      proposals: proposalsRes.data ?? [],
      signerSessions: signerSessionsRes.data ?? [],
      comments: commentsRes.data ?? [],
      requests: requestsRes.data ?? [],
      stipends: stipendsRes.data ?? [],
      distributionWallets: walletsRes.data ?? [],
      events: eventsRes.data ?? [],
      attestations: attestationsRes.data ?? [],
    });

    const safeName = (vaultRes.data.name || 'vault').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="dynastytrust_audit_${safeName}.pdf"`,
        'content-length': String(pdf.length),
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('Audit PDF error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Audit PDF generation failed: ' + err.message }),
      headers: { 'content-type': 'application/json' },
    };
  }
}
