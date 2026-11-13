/**
 * key-signin-placeholder-test.mjs -- the first step of email-free sign-in
 * (docs/key-signin-build-note.md, slice 1): prove on the LIVE Supabase
 * project that an account whose address is a never-mailed placeholder can
 * be created and logged into through the same one-time token path
 * wallet-signin-verify.js already uses. Operator, 2026-11-13: "Automate".
 *
 * Runs only in GitHub Actions (key-signin-placeholder-test.yml). It fetches
 * the project's admin key with the existing management token, masks it in
 * the log, and holds it in memory only. For each address form it tries:
 * create the account (confirmed, nothing sent) -> generate the one-time
 * login token (nothing sent) -> redeem it as the browser would -> check the
 * session is that account -> DELETE the account, always, even on failure.
 * Prints PASS/FAIL per step. Nothing else in the project is touched.
 */
const ref = process.env.SUPABASE_PROJECT_REF;
const pat = process.env.SUPABASE_ACCESS_TOKEN;
if (!ref || !pat) { console.error('missing SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN'); process.exit(1); }

const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, { headers: { authorization: `Bearer ${pat}` } });
if (!keysRes.ok) { console.error(`could not read project keys: HTTP ${keysRes.status}`); process.exit(1); }
const keys = await keysRes.json();
const pick = (name) => keys.find(k => k.name === name)?.api_key;
const service = pick('service_role'), anon = pick('anon');
if (!service || !anon) { console.error('project keys missing service_role/anon'); process.exit(1); }
console.log(`::add-mask::${service}`);
console.log(`::add-mask::${anon}`);

const base = `https://${ref}.supabase.co/auth/v1`;
const admin = { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' };
const call = async (method, path, body, headers = admin) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, ok: r.ok, body: j };
};
const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');

let allPass = true;
async function tryForm(label, email) {
  console.log(`\n== ${label}: ${email.replace(/^[^@]+/, 'k-<random>')}`);
  let userId = null;
  try {
    const c = await call('POST', '/admin/users', { email, email_confirm: true, user_metadata: { placeholder_test: true } });
    if (!c.ok || !c.body?.id) { console.log(`FAIL create account: HTTP ${c.status} ${c.body?.msg ?? c.body?.message ?? c.body?.error_description ?? ''}`); return false; }
    userId = c.body.id;
    console.log('PASS create account (confirmed, nothing sent)');
    const g = await call('POST', '/admin/generate_link', { type: 'magiclink', email });
    const tokenHash = g.body?.hashed_token ?? g.body?.properties?.hashed_token;
    if (!g.ok || !tokenHash) { console.log(`FAIL one-time login token: HTTP ${g.status} ${g.body?.msg ?? g.body?.message ?? ''}`); return false; }
    console.log('PASS one-time login token (nothing sent)');
    const v = await call('POST', '/verify', { type: 'magiclink', token_hash: tokenHash }, { apikey: anon, 'content-type': 'application/json' });
    const at = v.body?.access_token;
    if (!v.ok || !at) { console.log(`FAIL redeem token as the browser does: HTTP ${v.status} ${v.body?.msg ?? v.body?.error_description ?? ''}`); return false; }
    const claims = JSON.parse(Buffer.from(at.split('.')[1], 'base64url').toString());
    if (claims.sub !== userId) { console.log('FAIL session belongs to a different account'); return false; }
    console.log(`PASS session is that account (aal ${claims.aal}, amr ${JSON.stringify((claims.amr || []).map(a => a.method))})`);
    return true;
  } finally {
    if (userId) {
      const d = await call('DELETE', `/admin/users/${userId}`);
      console.log(d.ok ? 'PASS throwaway account deleted' : `FAIL could not delete throwaway account ${userId}: HTTP ${d.status} -- delete it by hand`);
      if (!d.ok) allPass = false;
    }
  }
}

// Username accounts (2026-11-13): made with a password at a never-mailed
// address, then signed in with Supabase's own password check exactly as
// the browser does (signInWithPassword -> /token?grant_type=password).
async function tryPassword() {
  const email = `u${rand()}@users.dynastytrust.family`;
  const password = `t-${rand()}-${rand()}`;
  console.log('\n== username account: <random>@users.dynastytrust.family');
  let userId = null;
  try {
    const c = await call('POST', '/admin/users', { email, password, email_confirm: true, user_metadata: { placeholder_test: true } });
    if (!c.ok || !c.body?.id) { console.log(`FAIL create username account: HTTP ${c.status} ${c.body?.msg ?? c.body?.message ?? ''}`); return false; }
    userId = c.body.id;
    console.log('PASS create username account (confirmed, nothing sent)');
    const t = await call('POST', '/token?grant_type=password', { email, password }, { apikey: anon, 'content-type': 'application/json' });
    if (!t.ok || !t.body?.access_token) { console.log(`FAIL password sign-in: HTTP ${t.status} ${t.body?.msg ?? t.body?.error_description ?? ''}`); return false; }
    const claims = JSON.parse(Buffer.from(t.body.access_token.split('.')[1], 'base64url').toString());
    if (claims.sub !== userId) { console.log('FAIL session belongs to a different account'); return false; }
    console.log('PASS password sign-in is that account');
    const w = await call('POST', '/token?grant_type=password', { email, password: password + 'x' }, { apikey: anon, 'content-type': 'application/json' });
    console.log(w.ok ? 'FAIL a wrong password signed in' : 'PASS a wrong password is refused');
    return !w.ok;
  } finally {
    if (userId) {
      const d = await call('DELETE', `/admin/users/${userId}`);
      console.log(d.ok ? 'PASS throwaway account deleted' : `FAIL could not delete throwaway account ${userId}: HTTP ${d.status} -- delete it by hand`);
      if (!d.ok) allPass = false;
    }
  }
}
const pw = await tryPassword();
const a = await tryForm('own domain, no mailbox', `k-${rand()}@keys.dynastytrust.family`);
const b = await tryForm('reserved .invalid domain', `k-${rand()}@key.invalid`);
console.log(`\nRESULT username-password=${pw ? 'PASS' : 'FAIL'} own-domain=${a ? 'PASS' : 'FAIL'} invalid-domain=${b ? 'PASS' : 'FAIL'}`);
process.exit(allPass && pw && (a || b) ? 0 : 1);
