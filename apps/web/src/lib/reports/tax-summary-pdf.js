// Moved from netlify/functions/vault-tax-summary.js (zero-knowledge storage, Z1 slice 4,
// docs/zero-knowledge-storage-plan.md): the server can no longer read the
// names, labels and notes this report prints, so the browser builds it from
// data it has opened with the vault key. The drawing code is unchanged; only
// its imports and its return value (bytes, not a Node Buffer) differ.
// Plain JavaScript like the original -- typed by the .d.ts beside it.
/**
 * vault-tax-summary.js -- per-vault per-year tax data summary PDF.
 *
 * Descriptive, not advisory. We never tell the user which forms
 * they must file, only pull together the numbers a CPA would want
 * and print them in one clean artifact.
 *
 * GET /api/vault-tax-summary?id=<vault_uuid>&year=<YYYY>&token=<jwt>
 *   token param is accepted because the client opens the URL with
 *   window.open() which cannot set Authorization headers.
 *
 * Included:
 *   - Vault header (name, network, address, creation date)
 *   - Spending policy summary (quorums, timelocks)
 *   - Member roster with roles + join dates
 *   - Funding events seen (vault creation, any rotated-from
 *     predecessor inflows visible to us)
 *   - Distributions (broadcast proposals) with destination,
 *     BTC amount, fee, txid, memo, block-height if available
 *   - Per-recipient totals in BTC for the year
 *   - Proposal + signature history
 *   - Attestations relevant for the year (trust_doc, proof_of_life,
 *     death_declaration)
 *   - Free-form "USD values" column left blank (with methodology
 *     note so the user can choose a price source)
 */

import { whoSignsShort } from '../path-words';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const GOLD      = rgb(0.788, 0.659, 0.298);
const GOLD_DIM  = rgb(0.545, 0.412, 0.078);
const DARK      = rgb(0.039, 0.039, 0.059);
const TEXT      = rgb(0.910, 0.894, 0.847);
const TEXT_DIM  = rgb(0.600, 0.580, 0.659);
const TEXT_MUTE = rgb(0.353, 0.333, 0.439);
const WHITE     = rgb(1, 1, 1);
const GREEN     = rgb(0.322, 0.769, 0.478);

const W = 595.28;
const H = 841.89;
const M = 48;
const FOOTER_Y = 52;

function fmtDate(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  } catch { return String(ts); }
}

function fmtDateTime(ts) {
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

function inYear(ts, year) {
  if (!ts) return false;
  try {
    return new Date(ts).getUTCFullYear() === Number(year);
  } catch { return false; }
}

function wrap(str, max) {
  if (!str) return ['-'];
  const words = String(str).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function buildSummaryPdf(data) {
  const { vault, year, members, proposals, signerSessions, events, attestations } = data;

  const doc = await PDFDocument.create();
  doc.setTitle(`DynastyTrust tax summary -- ${vault.name} -- ${year}`);
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
    p.drawText(`DYNASTYTRUST TAX SUMMARY -- ${year}`, {
      x: M, y: H - 36, size: 13, font: bold, color: GOLD,
    });
    p.drawText(vault.name || 'Unnamed Vault', {
      x: M, y: H - 52, size: 9, font: reg, color: TEXT_DIM,
    });
    const label = 'DESCRIPTIVE ONLY -- NOT TAX ADVICE';
    const lw = bold.widthOfTextAtSize(label, 8);
    p.drawText(label, { x: W - M - lw, y: H - 52, size: 8, font: bold, color: GOLD_DIM });
  }

  function footer(p) {
    p.drawRectangle({ x: 0, y: 0, width: W, height: 36, color: DARK });
    p.drawRectangle({ x: 0, y: 36, width: W, height: 0.5, color: GOLD_DIM, opacity: 0.4 });
    p.drawText('Generated ' + fmtDateTime(now) + ' . Provide to a crypto-literate CPA for filing.', {
      x: M, y: 14, size: 8, font: reg, color: TEXT_MUTE,
    });
    const pageStr = `Page ${pageNum}`;
    const pw = reg.widthOfTextAtSize(pageStr, 8);
    p.drawText(pageStr, { x: W - M - pw, y: 14, size: 8, font: reg, color: TEXT_MUTE });
  }

  function newPage() {
    if (page) footer(page);
    page = doc.addPage([W, H]);
    pageNum++;
    header(page);
    y = H - 80;
  }

  function ensureSpace(need) {
    if (y - need < FOOTER_Y) newPage();
  }

  function section(title) {
    ensureSpace(40);
    page.drawText(title, { x: M, y, size: 11, font: bold, color: GOLD });
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: GOLD_DIM, opacity: 0.5 });
    y -= 18;
  }

  function line(text, opts = {}) {
    const { size = 9, font = reg, color = TEXT_DIM, indent = 0, gap = 13 } = opts;
    ensureSpace(gap);
    page.drawText(String(text ?? '-'), { x: M + indent, y, size, font, color, maxWidth: W - 2 * M - indent });
    y -= gap;
  }

  function wrapped(text, opts = {}) {
    const { size = 9, font = reg, color = TEXT_DIM, indent = 0, max = 100 } = opts;
    for (const l of wrap(text, max)) {
      ensureSpace(12);
      page.drawText(l, { x: M + indent, y, size, font, color, maxWidth: W - 2 * M - indent });
      y -= 12;
    }
  }

  function keyValue(k, v, opts = {}) {
    const { valueMono = false } = opts;
    ensureSpace(14);
    page.drawText(k, { x: M, y, size: 8, font: bold, color: TEXT_MUTE });
    page.drawText(String(v ?? '-'), {
      x: M + 150, y, size: 9, font: valueMono ? mono : reg, color: TEXT,
      maxWidth: W - 2 * M - 150,
    });
    y -= 14;
  }

  // -- Page 1: cover --------------------------------------------------
  newPage();

  y -= 6;
  page.drawText(vault.name || 'Unnamed Vault', { x: M, y, size: 22, font: bold, color: WHITE });
  y -= 22;
  page.drawText(`Tax year ${year} . ${String(vault.network || 'testnet').toUpperCase()}`, {
    x: M, y, size: 10, font: reg, color: TEXT_DIM,
  });
  y -= 22;

  // Methodology note -- set expectations up front.
  ensureSpace(70);
  page.drawRectangle({
    x: M - 4, y: y - 52, width: W - 2 * M + 8, height: 66,
    borderColor: GOLD_DIM, borderWidth: 0.5, opacity: 0.9,
  });
  const note = [
    'About this document.',
    'This is a descriptive summary of vault activity for the tax year above.',
    'It is not a tax return and does not select which IRS forms you must file.',
    'USD values are intentionally not computed -- every filer can and should',
    'choose a price source (e.g. CoinDesk BPI, CoinGecko daily, exchange spot).',
    'Provide this document to a crypto-literate CPA along with your own USD',
    'valuations for the events listed here.',
  ];
  let ny = y + 2;
  for (const l of note) {
    page.drawText(l, { x: M + 2, y: ny - 12, size: 9, font: l.endsWith('.') && ny === y + 2 ? bold : reg, color: TEXT });
    ny -= 10;
  }
  y -= 60;

  // -- Vault summary --------------------------------------------------
  section('VAULT SUMMARY');
  keyValue('Network', vault.network);
  keyValue('Status', vault.status);
  keyValue('Address', vault.address, { valueMono: true });
  keyValue('Created', fmtDate(vault.created_at));
  // A custom leaf-list vault (including the Revocable living trust
  // template) has no founder_quorum/heir_quorum/recovery_after at all --
  // those columns sit at their defaults for this shape. Reading them
  // directly used to print "undefined of 0" here. Read vault.leaves
  // (LeafSpec[]) generically instead when present.
  if (Array.isArray(vault.leaves) && vault.leaves.length > 0) {
    for (const leaf of vault.leaves) {
      const name = leaf.label || leaf.id;
      const unlock = leaf.unlock || {};
      const timing = unlock.type === 'immediate' ? 'available now'
        : unlock.type === 'after' ? `after block ${(unlock.blocks || 0).toLocaleString()}`
        : unlock.type === 'older' ? `if untouched for ${(unlock.blocks || 0).toLocaleString()} blocks`
        : '-';
      keyValue(`${name} quorum`, `${whoSignsShort(leaf.quorum, (leaf.keys || []).length, (leaf.required_keys || []).length)} -- ${timing}`);
    }
  } else {
    keyValue('Founder quorum', `${vault.founder_quorum} of ${(vault.founder_keys || []).length}`);
    if (vault.heir_keys?.length) {
      keyValue('Heir quorum', `${vault.heir_quorum} of ${vault.heir_keys.length}`);
    }
    if (vault.recovery_after) keyValue('Recovery at block', (vault.recovery_after).toLocaleString());
    if (vault.inheritance_after) keyValue('Inheritance at block', (vault.inheritance_after).toLocaleString());
    if (vault.consent_quorum != null) keyValue('Consent quorum', `${vault.consent_quorum} of ${(vault.consent_keys || []).length}`);
  }
  y -= 6;

  // -- Member roster --------------------------------------------------
  section('MEMBER ROSTER');
  if (members.length === 0) {
    line('No members.', { color: TEXT_MUTE });
  } else {
    for (const m of members) {
      const who = `${String(m.role).toUpperCase()} . ${m.label || '(unlabeled)'}`;
      line(who, { font: bold, color: TEXT, size: 9 });
      line(`joined ${fmtDate(m.created_at)} . status ${m.status}${m.fingerprint ? ` . fp ${m.fingerprint}` : ''}`, {
        indent: 12, size: 8, color: TEXT_MUTE,
      });
      y -= 2;
    }
  }

  // -- Distributions in year -----------------------------------------
  const distributionsInYear = (proposals || []).filter(
    p => p.status === 'broadcast' && inYear(p.created_at, year),
  );
  const totalOutSats = distributionsInYear.reduce((n, p) => n + (p.amount_sats || 0), 0);
  const totalFeesSats = distributionsInYear.reduce((n, p) => n + (p.fee_sats || 0), 0);

  section(`DISTRIBUTIONS -- ${year}`);
  if (distributionsInYear.length === 0) {
    line('No broadcast distributions this year.', { color: TEXT_MUTE });
  } else {
    line(`${distributionsInYear.length} broadcast transaction(s) . ` +
         `${satsToBtc(totalOutSats)} BTC moved . ` +
         `${satsToBtc(totalFeesSats)} BTC in miner fees`, {
      font: bold, color: TEXT, size: 9,
    });
    y -= 4;

    for (const p of distributionsInYear) {
      ensureSpace(52);
      line(`${fmtDate(p.created_at)} . ${satsToBtc(p.amount_sats)} BTC . path: ${p.path}`, {
        font: bold, size: 10, color: TEXT,
      });
      if (p.destination) {
        line(`to ${p.destination}`, { indent: 12, font: mono, size: 7.5, color: TEXT_DIM, gap: 10 });
      }
      if (p.txid) {
        line(`txid ${p.txid}`, { indent: 12, font: mono, size: 7.5, color: TEXT_MUTE, gap: 10 });
      }
      if (p.fee_sats != null) {
        line(`fee ${satsToBtc(p.fee_sats)} BTC`, { indent: 12, size: 8, color: TEXT_DIM });
      }
      if (p.memo) {
        wrapped(`memo: ${p.memo}`, { indent: 12, size: 8, color: TEXT_DIM });
      }
      line(`USD at transaction time: ______________________________________`, {
        indent: 12, size: 8, color: TEXT_MUTE, font: mono,
      });
      y -= 6;
    }
  }

  // -- Proposal + signature activity in year -------------------------
  const proposalsInYear = (proposals || []).filter(p => inYear(p.created_at, year));
  const sigsInYear = (signerSessions || []).filter(s => inYear(s.signed_at || s.created_at, year));

  section(`PROPOSAL + SIGNATURE ACTIVITY -- ${year}`);
  if (proposalsInYear.length === 0) {
    line('No proposal activity this year.', { color: TEXT_MUTE });
  } else {
    line(`${proposalsInYear.length} proposal(s) filed . ${sigsInYear.length} signature(s) recorded`, {
      font: bold, size: 9, color: TEXT,
    });
    y -= 4;
    for (const p of proposalsInYear) {
      const statusColor =
        p.status === 'broadcast' ? GREEN :
        p.status === 'cancelled' ? TEXT_MUTE :
        TEXT_DIM;
      line(`${fmtDate(p.created_at)} . ${satsToBtc(p.amount_sats)} BTC . ${String(p.status).toUpperCase()}`, {
        size: 9, color: statusColor,
      });
    }
  }

  // -- Attestations in year ------------------------------------------
  const attInYear = (attestations || []).filter(a => inYear(a.signed_at, year));
  section(`ATTESTATIONS -- ${year}`);
  if (attInYear.length === 0) {
    line('No attestations recorded this year.', { color: TEXT_MUTE });
  } else {
    const byType = {
      trust_doc: attInYear.filter(a => a.attestation_type === 'trust_doc'),
      proof_of_life: attInYear.filter(a => a.attestation_type === 'proof_of_life'),
      death_declaration: attInYear.filter(a => a.attestation_type === 'death_declaration'),
    };
    const memberLabel = id => (members.find(m => m.user_id === id) || {}).label || '(unknown)';
    if (byType.trust_doc.length) {
      line(`Trust doc: ${byType.trust_doc.length} attestations`, { font: bold, size: 9, color: GOLD });
    }
    if (byType.proof_of_life.length) {
      line(`Proof of life: ${byType.proof_of_life.length} check-ins`, { font: bold, size: 9, color: GREEN });
      for (const a of byType.proof_of_life) {
        line(`. ${memberLabel(a.user_id)} at ${fmtDate(a.signed_at)}`, { indent: 12, size: 8, color: TEXT_DIM });
      }
    }
    if (byType.death_declaration.length) {
      line(`Death declarations: ${byType.death_declaration.length}`, { font: bold, size: 9, color: rgb(0.878, 0.361, 0.361) });
    }
  }

  // -- Events log -- filtered to year + the ones that matter --------
  const taxyEvents = (events || []).filter(
    e => inYear(e.created_at, year) &&
    [
      'created', 'rotated_to_successor', 'rotated_from_predecessor',
      'member_added', 'member_removed', 'terms_accepted',
    ].includes(e.event_type),
  );
  if (taxyEvents.length > 0) {
    section(`GOVERNANCE EVENTS -- ${year}`);
    for (const e of taxyEvents) {
      line(`${fmtDate(e.created_at)} . ${e.event_type}`, { size: 9, color: TEXT });
    }
  }

  // -- CPA handoff checklist ----------------------------------------
  section('FOR YOUR CPA');
  const cpaLines = [
    'Determine whether this trust is grantor or non-grantor for tax year ' + year + '.',
    'For each distribution: compute USD value using the price source of your choice.',
    'Non-grantor trusts: Form 1041 + Schedule K-1 per beneficiary who received distributions.',
    'Grantor trusts: income typically flows to the grantor\'s personal 1040.',
    'Funding event in the year > $19,000 per recipient (2025 exclusion): consider Form 709.',
    'If the wrapper is a foreign trust: Form 3520 / 3520-A may apply.',
    'Beneficiaries who later sell BTC received: Form 8949 captures the capital gain.',
    'This document is not itself any of the above forms. It is source data.',
  ];
  for (const l of cpaLines) {
    wrapped('. ' + l, { indent: 0, size: 9, color: TEXT, max: 96 });
    y -= 2;
  }

  if (page) footer(page);
  const bytes = await doc.save();
  return bytes;
}
