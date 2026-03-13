/**
 * GET /api/vault-pdf?id=<vault-uuid>
 *
 * Generates a branded client-facing PDF summary for a vault.
 * Returns the PDF as binary (application/pdf).
 *
 * Requires: pdf-lib (add to package.json dependencies)
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import QRCode from 'qrcode';
import { requireUser } from './_auth.js';
import { getSupabaseAdmin } from './_supabase.js';

// ── Colors ────────────────────────────────────────────────────────────────────
const GOLD      = rgb(0.788, 0.659, 0.298);  // #C9A84C
const GOLD_DIM  = rgb(0.545, 0.412, 0.078);  // #8B6914
const DARK      = rgb(0.039, 0.039, 0.059);  // #0A0A0F
const SURFACE   = rgb(0.086, 0.086, 0.133);  // #161622
const TEXT      = rgb(0.910, 0.894, 0.847);  // #E8E4D8
const TEXT_DIM  = rgb(0.600, 0.580, 0.659);  // #9994A8
const TEXT_MUTE = rgb(0.353, 0.333, 0.439);  // #5A5570
const WHITE     = rgb(1, 1, 1);
const GREEN     = rgb(0.322, 0.769, 0.478);  // #52C47A

// ── Page setup ────────────────────────────────────────────────────────────────
const W = 595.28;   // US Letter width in points (8.5")
const H = 841.89;   // US Letter height in points (11")
const M = 48;       // margin

// ── Helpers ──────────────────────────────────────────────────────────────────
function blocksToLabel(blocks) {
  if (!blocks) return '—';
  const days = Math.round(blocks * 10 / 60 / 24);
  if (days < 30)  return `~${days} days`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return `~${(days / 365).toFixed(1)} years`;
}

function truncate(str, max = 52) {
  if (!str) return '—';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Draw a QR code into the PDF at position (x, y) with given size.
 * Uses the `qrcode` npm package to get the module grid, then draws
 * filled squares using pdf-lib's drawRectangle.
 */
async function drawQRCodeOnPage(page, text, x, y, size = 90) {
  try {
    // Get QR module matrix (2D boolean array)
    const matrix = await QRCode.create(text, { errorCorrectionLevel: 'M' });
    const modules = matrix.modules;
    const count   = modules.size;
    const cellSz  = size / count;

    // White background
    page.drawRectangle({ x, y: y - size, width: size, height: size, color: rgb(1,1,1) });

    // Draw dark modules
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (modules.data[row * count + col]) {
          page.drawRectangle({
            x:      x + col * cellSz,
            y:      y - size + (count - row - 1) * cellSz,
            width:  cellSz + 0.5,  // +0.5 avoids hairline gaps
            height: cellSz + 0.5,
            color:  rgb(0, 0, 0),
          });
        }
      }
    }
  } catch (err) {
    // If QR generation fails, draw a placeholder box
    page.drawRectangle({ x, y: y - size, width: size, height: size,
      borderColor: GOLD_DIM, borderWidth: 1, color: SURFACE });
    console.warn('QR generation failed:', err.message);
  }
}

function drawHRule(page, y, color = GOLD_DIM, opacity = 0.4) {
  page.drawLine({
    start: { x: M, y },
    end:   { x: W - M, y },
    thickness: 0.5,
    color,
    opacity,
  });
}

function drawRect(page, x, y, w, h, color, opacity = 1) {
  page.drawRectangle({ x, y, width: w, height: h, color, opacity });
}

// ── PDF Builder ───────────────────────────────────────────────────────────────
async function buildVaultPDF(vault) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`DynastyTrust Vault — ${vault.name}`);
  pdfDoc.setAuthor('DynastyTrust');
  pdfDoc.setCreator('DynastyTrust Platform');
  pdfDoc.setCreationDate(new Date());

  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const mono    = await pdfDoc.embedFont(StandardFonts.Courier);

  // ── Page 1: Overview ───────────────────────────────────────────────────────
  const p1 = pdfDoc.addPage([W, H]);
  let y = H;

  // Header bar
  drawRect(p1, 0, H - 72, W, 72, DARK);
  drawRect(p1, 0, H - 74, W, 2, GOLD);

  p1.drawText('DYNASTYTRUST', {
    x: M, y: H - 44,
    size: 18, font: bold, color: GOLD,
  });
  p1.drawText('Bitcoin Vault Summary', {
    x: M, y: H - 62,
    size: 10, font: regular, color: TEXT_DIM,
  });

  // Date top right
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const dw = bold.widthOfTextAtSize(dateStr, 9);
  p1.drawText(dateStr, {
    x: W - M - dw, y: H - 44,
    size: 9, font: regular, color: TEXT_DIM,
  });

  y = H - 104;

  // Vault name
  p1.drawText(vault.name || 'Unnamed Vault', {
    x: M, y,
    size: 22, font: bold, color: WHITE,
  });
  y -= 24;

  // Network + type badges
  const net = (vault.network === 'bitcoin' ? 'MAINNET' : 'TESTNET');
  const addrType = (vault.address_type || 'tr').toUpperCase();

  drawRect(p1, M, y - 14, 68, 18, vault.network === 'bitcoin' ? GOLD_DIM : rgb(0.2, 0.5, 0.3), 0.6);
  p1.drawText(net, { x: M + 6, y: y - 10, size: 8, font: bold, color: WHITE });

  drawRect(p1, M + 76, y - 14, 52, 18, SURFACE, 1);
  p1.drawText(addrType, { x: M + 82, y: y - 10, size: 8, font: bold, color: GOLD });

  y -= 36;
  drawHRule(p1, y);
  y -= 24;

  // ── Section: Bitcoin Address + QR Code ───────────────────────────────────
  p1.drawText('BITCOIN ADDRESS', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 16;

  // Address text box (left side, leaving room for QR on right)
  const QR_SIZE = 96;
  const addrBoxW = W - M * 2 - QR_SIZE - 16;

  drawRect(p1, M, y - 44, addrBoxW, 54, SURFACE);
  // Wrap long address across two lines if needed
  const addr = vault.address || '—';
  const addrMid = Math.floor(addr.length / 2);
  p1.drawText(addr.slice(0, addrMid), {
    x: M + 10, y: y - 18, size: 8, font: mono, color: TEXT, maxWidth: addrBoxW - 16,
  });
  p1.drawText(addr.slice(addrMid), {
    x: M + 10, y: y - 32, size: 8, font: mono, color: TEXT, maxWidth: addrBoxW - 16,
  });

  // QR code (right side, same vertical band)
  const qrX = W - M - QR_SIZE;
  const qrY = y + 8;  // top of QR = top of address box
  await drawQRCodeOnPage(p1, addr, qrX, qrY, QR_SIZE);

  // Label under QR
  p1.drawText('Scan to verify', {
    x: qrX + 4, y: qrY - QR_SIZE - 10,
    size: 7, font: regular, color: TEXT_MUTE,
  });

  y -= 60;

  p1.drawText('Fund the vault by sending Bitcoin to this address. Scan the QR code with your wallet. Verify on your hardware device before sending.',
    { x: M, y, size: 9, font: regular, color: TEXT_MUTE, maxWidth: W - M * 2 });
  y -= 32;

  drawHRule(p1, y);
  y -= 24;

  // ── Section: Policy Overview ───────────────────────────────────────────────
  p1.drawText('VAULT POLICY', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 18;

  p1.drawText(
    'This vault is governed by a Miniscript policy encoding three spending paths. ' +
    'All spending requires valid signatures from hardware devices — no private keys are stored online.',
    { x: M, y, size: 10, font: regular, color: TEXT_DIM, maxWidth: W - M * 2, lineHeight: 16 }
  );
  y -= 44;

  // Three spending paths as cards
  const paths = [
    {
      title: 'PATH 1 — Founders (Available Now)',
      color: GOLD,
      body: `${vault.founder_quorum || 2} of ${(vault.founder_keys || []).length} founder signatures required. ` +
            `Founders can spend at any time for normal trust operations, rebalancing, or distributions.`,
    },
    {
      title: `PATH 2 — Founder Recovery (After ${blocksToLabel(vault.recovery_after)})`,
      color: rgb(0.322, 0.580, 0.769),
      body: `After ${(vault.recovery_after || 0).toLocaleString()} blocks (~${blocksToLabel(vault.recovery_after)}), ` +
            `founders can spend using a recovery path. Useful if primary signing devices are lost or unavailable.`,
    },
    {
      title: `PATH 3 — Heir Inheritance (After ${blocksToLabel(vault.inheritance_after)})`,
      color: GREEN,
      body: `After ${(vault.inheritance_after || 0).toLocaleString()} blocks (~${blocksToLabel(vault.inheritance_after)}), ` +
            `${vault.heir_quorum || 2} of ${(vault.heir_keys || []).length} heir signatures can spend. ` +
            `This is the dynasty inheritance path.`,
    },
  ];

  for (const path of paths) {
    drawRect(p1, M, y - 52, W - M * 2, 62, SURFACE);
    drawRect(p1, M, y + 8, 3, 62, path.color);
    p1.drawText(path.title, { x: M + 12, y: y, size: 9, font: bold, color: WHITE });
    p1.drawText(path.body, {
      x: M + 12, y: y - 16,
      size: 9, font: regular, color: TEXT_DIM,
      maxWidth: W - M * 2 - 24, lineHeight: 14,
    });
    y -= 74;
  }

  y -= 8;
  drawHRule(p1, y);
  y -= 24;

  // ── Section: Key Configuration ─────────────────────────────────────────────
  p1.drawText('KEY CONFIGURATION', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 18;

  const configRows = [
    ['Founder Keys', `${(vault.founder_keys || []).length} keys`],
    ['Founder Quorum', `${vault.founder_quorum} of ${(vault.founder_keys || []).length} required`],
    ['Heir Keys', `${(vault.heir_keys || []).length} keys`],
    ['Heir Quorum', `${vault.heir_quorum} of ${(vault.heir_keys || []).length} required`],
    ['Recovery Timelock', `${(vault.recovery_after || 0).toLocaleString()} blocks (${blocksToLabel(vault.recovery_after)})`],
    ['Inheritance Timelock', `${(vault.inheritance_after || 0).toLocaleString()} blocks (${blocksToLabel(vault.inheritance_after)})`],
    ['Address Type', (vault.address_type || 'tr').toUpperCase()],
    ['Network', vault.network === 'bitcoin' ? 'Bitcoin Mainnet' : 'Testnet'],
  ];

  for (let i = 0; i < configRows.length; i++) {
    const [label, value] = configRows[i];
    if (i % 2 === 0) drawRect(p1, M, y - 14, W - M * 2, 20, SURFACE, 0.5);
    p1.drawText(label, { x: M + 10, y: y - 8, size: 9, font: regular, color: TEXT_MUTE });
    p1.drawText(value, { x: M + 200, y: y - 8, size: 9, font: bold, color: TEXT });
    y -= 22;
  }

  // Footer p1
  drawRect(p1, 0, 0, W, 36, DARK);
  drawRect(p1, 0, 36, W, 1, GOLD_DIM, 0.3);
  p1.drawText('DynastyTrust — Confidential Client Document', {
    x: M, y: 13, size: 8, font: regular, color: TEXT_MUTE,
  });
  p1.drawText('Page 1 of 2', {
    x: W - M - 40, y: 13, size: 8, font: regular, color: TEXT_MUTE,
  });

  // ── Page 2: Descriptor + Keys + Signing Instructions ──────────────────────
  const p2 = pdfDoc.addPage([W, H]);
  y = H;

  // Header bar (same)
  drawRect(p2, 0, H - 72, W, 72, DARK);
  drawRect(p2, 0, H - 74, W, 2, GOLD);
  p2.drawText('DYNASTYTRUST', { x: M, y: H - 44, size: 18, font: bold, color: GOLD });
  p2.drawText('Technical Details & Signing Instructions', { x: M, y: H - 62, size: 10, font: regular, color: TEXT_DIM });

  y = H - 100;

  // ── Output Descriptor ──────────────────────────────────────────────────────
  p2.drawText('OUTPUT DESCRIPTOR', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 14;
  p2.drawText('Import this descriptor into Sparrow Wallet or Nunchuk to watch the vault balance and prepare transactions.',
    { x: M, y, size: 9, font: regular, color: TEXT_MUTE, maxWidth: W - M * 2 });
  y -= 20;

  const desc = vault.descriptor || '—';
  const descLines = [];
  for (let i = 0; i < desc.length; i += 62) descLines.push(desc.slice(i, i + 62));
  const descH = descLines.length * 14 + 16;

  drawRect(p2, M, y - descH + 8, W - M * 2, descH, SURFACE);
  for (let i = 0; i < descLines.length; i++) {
    p2.drawText(descLines[i], { x: M + 10, y: y - 6 - i * 14, size: 8, font: mono, color: TEXT });
  }
  y -= descH + 16;

  drawHRule(p2, y);
  y -= 20;

  // ── Founder Public Keys ────────────────────────────────────────────────────
  p2.drawText('FOUNDER PUBLIC KEYS', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 16;

  for (let i = 0; i < (vault.founder_keys || []).length; i++) {
    const k = vault.founder_keys[i];
    p2.drawText(`Founder ${i + 1}`, { x: M, y, size: 8, font: bold, color: TEXT_DIM });
    drawRect(p2, M, y - 18, W - M * 2, 22, SURFACE);
    p2.drawText(k || '—', { x: M + 8, y: y - 12, size: 7.5, font: mono, color: TEXT, maxWidth: W - M * 2 - 16 });
    y -= 32;
  }

  y -= 4;
  drawHRule(p2, y);
  y -= 20;

  // ── Heir Public Keys ───────────────────────────────────────────────────────
  p2.drawText('HEIR PUBLIC KEYS', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 16;

  for (let i = 0; i < (vault.heir_keys || []).length; i++) {
    const k = vault.heir_keys[i];
    p2.drawText(`Heir ${i + 1}`, { x: M, y, size: 8, font: bold, color: TEXT_DIM });
    drawRect(p2, M, y - 18, W - M * 2, 22, SURFACE);
    p2.drawText(k || '—', { x: M + 8, y: y - 12, size: 7.5, font: mono, color: TEXT, maxWidth: W - M * 2 - 16 });
    y -= 32;
  }

  y -= 4;
  drawHRule(p2, y);
  y -= 20;

  // ── Signing Instructions ───────────────────────────────────────────────────
  p2.drawText('HOW TO SPEND FROM THIS VAULT', { x: M, y, size: 8, font: bold, color: GOLD });
  y -= 16;

  const steps = [
    ['1. Import the descriptor', 'Open Sparrow Wallet → File → Import Wallet → Output Descriptor. Paste the descriptor above. This creates a watch-only wallet showing the vault balance.'],
    ['2. Connect your hardware device', 'Connect your Coldcard, Trezor, or Ledger to Sparrow. The device holds the private key corresponding to your public key above.'],
    ['3. Build the transaction', 'In Sparrow, go to Send. Enter the destination address and amount. Click Create Transaction. Sparrow builds an unsigned PSBT.'],
    ['4. Sign with required devices', `This vault requires ${vault.founder_quorum || 2} of ${(vault.founder_keys || []).length} founder signatures. Each signer must sign the PSBT on their hardware device.`],
    ['5. Broadcast', 'Once enough signatures are collected, Sparrow will allow you to broadcast the transaction to the Bitcoin network.'],
  ];

  for (const [title, body] of steps) {
    if (y < 120) break; // don't overflow page 2
    p2.drawText(title, { x: M, y, size: 9, font: bold, color: TEXT });
    y -= 14;
    p2.drawText(body, {
      x: M + 12, y,
      size: 9, font: regular, color: TEXT_DIM,
      maxWidth: W - M * 2 - 12, lineHeight: 14,
    });
    y -= 36;
  }

  // ── Important Notice ───────────────────────────────────────────────────────
  if (y > 100) {
    y -= 8;
    drawRect(p2, M, y - 50, W - M * 2, 60, rgb(0.12, 0.06, 0.06));
    drawRect(p2, M, y + 8, 3, 60, rgb(0.87, 0.32, 0.32));
    p2.drawText('IMPORTANT', { x: M + 12, y: y, size: 9, font: bold, color: rgb(0.87, 0.5, 0.5) });
    p2.drawText(
      'Never share your seed phrase or private keys. DynastyTrust stores only public keys and addresses. ' +
      'All signing happens offline on your hardware device. If you lose access to your signing devices, ' +
      'use the recovery path after the recovery timelock expires.',
      { x: M + 12, y: y - 16, size: 8.5, font: regular, color: TEXT_DIM, maxWidth: W - M * 2 - 24, lineHeight: 13 }
    );
  }

  // Footer p2
  drawRect(p2, 0, 0, W, 36, DARK);
  drawRect(p2, 0, 36, W, 1, GOLD_DIM, 0.3);
  p2.drawText('DynastyTrust — Confidential Client Document', { x: M, y: 13, size: 8, font: regular, color: TEXT_MUTE });
  p2.drawText('Page 2 of 2', { x: W - M - 40, y: 13, size: 8, font: regular, color: TEXT_MUTE });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const u = await requireUser(event);
  if (u.error) {
    return { statusCode: 401, body: JSON.stringify({ error: u.error }),
             headers: { 'content-type': 'application/json' } };
  }

  const id = event.queryStringParameters?.id;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing query param: id' }),
             headers: { 'content-type': 'application/json' } };
  }

  const supabase = getSupabaseAdmin();
  const { data: vault, error } = await supabase
    .from('vaults')
    .select('*')
    .eq('id', id)
    .eq('user_id', u.userId)
    .single();

  if (error || !vault) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Vault not found' }),
             headers: { 'content-type': 'application/json' } };
  }

  try {
    const pdfBuffer = await buildVaultPDF(vault);
    const safeName = (vault.name || 'vault').replace(/[^a-z0-9]/gi, '_').toLowerCase();

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="dynastytrust_${safeName}.pdf"`,
        'content-length': String(pdfBuffer.length),
      },
      body: pdfBuffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('PDF generation error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'PDF generation failed: ' + err.message }),
             headers: { 'content-type': 'application/json' } };
  }
}
