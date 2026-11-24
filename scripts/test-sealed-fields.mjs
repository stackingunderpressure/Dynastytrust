/**
 * test-sealed-fields.mjs -- zero-knowledge storage, Z1 slice 2
 * (docs/zero-knowledge-storage-plan.md): the keyring (lib/vault-keyring.ts),
 * the per-row openers (lib/sealed-fields.ts), text that waits on the device
 * for the key (lib/sealed-pending.ts) and the invite link's fragment
 * (lib/invite-link.ts). Wired into `npm test`.
 *
 * Run:  node --experimental-strip-types --import ./scripts/register-ts-resolver.mjs scripts/test-sealed-fields.mjs
 */
import assert from 'node:assert/strict';

let n = 0; const pass = (l) => { n++; console.log(`  [ok] ${l}`); };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const session = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (session.has(k) ? session.get(k) : null),
  setItem: (k, v) => session.set(k, String(v)),
  removeItem: (k) => session.delete(k),
};
globalThis.window = { location: { origin: 'https://dynastytrust.family', hash: '' } };

const vk = await import('../apps/web/src/lib/vault-key.ts');
const ring = await import('../apps/web/src/lib/vault-keyring.ts');
const sf = await import('../apps/web/src/lib/sealed-fields.ts');
const pending = await import('../apps/web/src/lib/sealed-pending.ts');
const link = await import('../apps/web/src/lib/invite-link.ts');
const { F } = sf;

const V = 'vault-a';
const key1 = vk.newVaultKey();

// 1. Seal and open through the keyring; never plain text, never a fallback.
{
  ring.clearVaultKeyring();
  assert.throws(() => ring.sealVaultText(V, F.vaultName, 'Winchester Family Trust'), ring.VaultKeyNotReady, 'no key: refuse, never send plain');
  assert.equal(ring.sealVaultText(V, F.vaultName, ''), '', 'empty says nothing and is sent as is');
  assert.equal(ring.sealVaultText(V, F.vaultName, null), null);
  ring.setVaultKeys(V, new Map([[1, key1]]), 1);
  const sealed = ring.sealVaultText(V, F.vaultName, 'Winchester Family Trust');
  assert.ok(sealed.startsWith('zk1:1:') && !sealed.includes('Winchester'));
  assert.equal(ring.sealVaultText(V, F.vaultName, sealed), sealed, 'an already-sealed value is not sealed twice');
  assert.equal(ring.openVaultText(V, F.vaultName, sealed), 'Winchester Family Trust');
  assert.equal(ring.openVaultText(V, F.stipendName, sealed), ring.LOCKED_TEXT, 'a vault name cannot be replayed as a stipend name');
  assert.equal(ring.openVaultText('vault-b', F.vaultName, sealed), ring.LOCKED_TEXT, 'nor moved to another vault');
  assert.equal(ring.openVaultText(V, F.vaultName, 'Old plain name'), 'Old plain name', 'legacy plain values pass through');
  ring.clearVaultKeyring();
  assert.equal(ring.openVaultText(V, F.vaultName, sealed), ring.LOCKED_TEXT, 'without the key it reads Locked, never ciphertext');
  pass('text is sealed only with the vault key, opens only as the same field of the same vault, and reads "Locked" without the key');
}

// 2. Every row type opens; nothing sealed reaches a page.
{
  ring.clearVaultKeyring();
  ring.setVaultKeys(V, new Map([[1, key1]]), 1);
  const s = (field, t) => ring.sealVaultText(V, field, t);
  const vault = sf.openVault({
    id: V, name: s(F.vaultName, 'Family'), key_labels: [{ pubkey: 'p1', label: s(F.keyLabel, "Dad's Jade") }],
    trust_doc: ring.sealVaultJson(V, F.trustDoc, { purpose: 'College for the kids', rules: [{ id: 'r1', name: 'Tuition' }] }),
  });
  assert.equal(vault.name, 'Family');
  assert.equal(vault.key_labels[0].label, "Dad's Jade");
  assert.deepEqual(vault.trust_doc, { purpose: 'College for the kids', rules: [{ id: 'r1', name: 'Tuition' }] });
  assert.equal(sf.openMember({ vault_id: V, label: s(F.memberLabel, 'Anna'), key_label: s(F.memberKeyLabel, 'Phone') }).label, 'Anna');
  assert.equal(sf.openInvite({ vault_id: V, invited_label: s(F.memberLabel, 'Anna') }).invited_label, 'Anna', 'invite and member labels share one field (the server copies one to the other)');
  const req = sf.openRequest({ vault_id: V, rule_name: s(F.requestRuleName, 'Tuition'), recipient_name: s(F.requestRecipient, 'State U'), reason: s(F.requestReason, 'Spring term'), resolution_note: null });
  assert.deepEqual([req.rule_name, req.recipient_name, req.reason, req.resolution_note], ['Tuition', 'State U', 'Spring term', null]);
  const st = sf.openStipend({ vault_id: V, name: s(F.stipendName, 'Allowance'), recipient_name: s(F.stipendRecipient, 'Sam') });
  assert.deepEqual([st.name, st.recipient_name], ['Allowance', 'Sam']);
  const w = sf.openWallet({ vault_id: V, name: s(F.walletName, 'Sam at 25'), beneficiary_name: s(F.walletBeneficiary, 'Sam') });
  assert.deepEqual([w.name, w.beneficiary_name], ['Sam at 25', 'Sam']);
  const sec = sf.openSecret({ label: s(F.secretLabel, 'Circle phrase'), recipients: [{ label: s(F.secretRecipient, 'Anna'), persona: 'heir' }] }, V);
  assert.deepEqual([sec.label, sec.recipients[0].label, sec.recipients[0].persona], ['Circle phrase', 'Anna', 'heir']);
  const att = sf.openAttestation({ vault_id: V, target_data: ring.sealVaultJson(V, F.attestationData, { notes: 'Passed March 3' }) });
  assert.deepEqual(att.target_data, { notes: 'Passed March 3' });
  const prop = sf.openProposal({
    vault_id: V, memo: s(F.proposalMemo, 'Roof repair'),
    signer_sessions: [{ label: s(F.signerLabel, 'Hardware wallet') }, { label: s(F.memberLabel, 'Anna') }, { label: null }],
    vault: { id: V, name: s(F.vaultName, 'Family') },
  });
  assert.equal(prop.memo, 'Roof repair');
  assert.deepEqual(prop.signer_sessions.map(x => x.label), ['Hardware wallet', 'Anna', null], "a signer's own label, or the member label the server copied");
  assert.equal(prop.vault.name, 'Family');
  assert.ok(!JSON.stringify([vault, req, st, w, sec, att, prop]).includes('zk1:'), 'no sealed text reaches a page');
  // A sealed trust document this member cannot open reads as empty, not as {zk}.
  ring.clearVaultKeyring();
  assert.deepEqual(sf.openVault({ id: V, trust_doc: { zk: 'zk1:1:AAAA' } }).trust_doc, {});
  pass('vault names, key and member labels, trust document, requests, stipends, wallets, sent secrets, attestations, memos and signer labels all open');
}

// 3. A replacement vault reads the values it copied from its predecessor.
{
  ring.clearVaultKeyring();
  const oldKey = vk.newVaultKey(); const newKey = vk.newVaultKey();
  ring.setVaultKeys('old', new Map([[1, oldKey]]), 1);
  const copied = ring.sealVaultText('old', F.memberLabel, 'Anna');
  ring.setVaultKeys('new', new Map([[1, newKey]]), 1);
  assert.equal(sf.openMember({ vault_id: 'new', label: copied }).label, ring.LOCKED_TEXT, 'before the link is known');
  sf.openVault({ id: 'new', predecessor_id: 'old', name: 'x' });
  assert.equal(sf.openMember({ vault_id: 'new', label: copied }).label, 'Anna', 'opens through predecessor_id');
  const fresh = ring.sealVaultText('new', F.memberLabel, 'Anna');
  assert.equal(ring.openVaultText('old', F.memberLabel, fresh), ring.LOCKED_TEXT, 'new writes use the successor key only');
  pass("a replacement vault opens the names it copied from its predecessor; what it writes is sealed under its own key");
}

// 4. A key the member received in a later version still opens older values.
{
  ring.clearVaultKeyring();
  const k2 = vk.newVaultKey();
  ring.setVaultKeys(V, new Map([[1, key1]]), 1);
  const v1 = ring.sealVaultText(V, F.vaultName, 'Before');
  ring.setVaultKeys(V, new Map([[2, k2]]), 2);
  const v2 = ring.sealVaultText(V, F.vaultName, 'After');
  assert.ok(v2.startsWith('zk1:2:'));
  assert.equal(ring.openVaultText(V, F.vaultName, v1), 'Before');
  assert.equal(ring.openVaultText(V, F.vaultName, v2), 'After');
  assert.equal(ring.vaultKeyVersion(V), 2);
  pass('after the key is replaced, new text uses the new version and older text still opens');
}

// 5. Text that waits on the device for the key.
{
  store.clear();
  assert.equal(pending.loadPending(V), null);
  pending.savePending(V, { label: 'Anna' });
  pending.savePending(V, { key_label: 'Phone' });
  assert.deepEqual(pending.loadPending(V), { label: 'Anna', key_label: 'Phone' });
  pending.clearPending(V);
  assert.equal(pending.loadPending(V), null);
  pass('a label that cannot be sealed yet waits on this device only, and is cleared once saved');
}

// 6. The invite link carries the names in its fragment, which never reaches a server.
{
  const url = link.inviteLink('tok123', { vaultName: 'Family & Friends #1', label: 'Anna' });
  assert.ok(url.startsWith('https://dynastytrust.family/invite/tok123#'));
  const [path, frag] = url.split('#');
  assert.ok(!path.includes('Family') && !path.includes('Anna'), 'nothing in the part a server sees');
  assert.deepEqual(link.readInviteHint('tok123', '#' + frag), { vaultName: 'Family & Friends #1', label: 'Anna' });
  assert.deepEqual(link.readInviteHint('tok123', ''), { vaultName: 'Family & Friends #1', label: 'Anna' }, 'kept across a sign-in that drops the fragment');
  assert.deepEqual(link.readInviteHint('other', ''), {});
  assert.equal(link.inviteLink('tok9'), 'https://dynastytrust.family/invite/tok9');
  pass('the invite link carries the vault name and invited name after the #, and keeps them through sign-in');
}

// 7. History entries (Z1 slice 3): the names they copied open for display;
//    the stored payload, which the ledger hashes, is never changed.
{
  ring.clearVaultKeyring();
  ring.setVaultKeys(V, new Map([[1, key1]]), 1);
  const payload = {
    from: ring.sealVaultText(V, F.vaultName, 'Old name'),
    to: ring.sealVaultText(V, F.vaultName, 'New name'),
    nested: [{ label: ring.sealVaultText(V, F.memberLabel, 'Anna') }],
    snapshot: ring.sealVaultJson(V, F.attestationData, { notes: 'kept' }),
    amount_sats: 5000,
    note: 'plain text stays',
  };
  const stored = JSON.stringify(payload);
  const shown = sf.openSealedDeep(V, payload);
  assert.deepEqual(shown, { from: 'Old name', to: 'New name', nested: [{ label: 'Anna' }], snapshot: { notes: 'kept' }, amount_sats: 5000, note: 'plain text stays' });
  assert.equal(JSON.stringify(payload), stored, 'the stored payload is untouched (the ledger hash is computed over it)');
  ring.clearVaultKeyring();
  assert.deepEqual(sf.openSealedDeep(V, payload).nested, [{ label: ring.LOCKED_TEXT }], 'no key: Locked, never ciphertext');
  assert.equal(sf.openSealedDeep(V, payload).snapshot, ring.LOCKED_TEXT);
  pass('history entries show the names they copied, opened on the device; the stored, hashed payload never changes');
}

console.log(`sealed fields: ${n} checks passed`);
