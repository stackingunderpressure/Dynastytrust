// Read-only: print the live project's auth settings that decide whether
// email sign-ups can be made to prove the inbox (threat model, 2026-11-13:
// the public settings endpoint showed mailer_autoconfirm true). Prints only
// non-secret facts -- never the SMTP password or any key. Changes nothing.
//
// Run by the hand-run live-check workflow. Needs SUPABASE_ACCESS_TOKEN and
// SUPABASE_PROJECT_REF.
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) { console.error("SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required"); process.exit(1); }

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) { console.error(`Management API GET config/auth: HTTP ${res.status}`); process.exit(1); }
const c = await res.json();

const has = k => Object.prototype.hasOwnProperty.call(c, k);
const out = {
  mailer_autoconfirm: c.mailer_autoconfirm,
  external_email_enabled: c.external_email_enabled,
  disable_signup: c.disable_signup,
  own_mail_sender: Boolean(c.smtp_host),
  smtp_host: c.smtp_host || null,
  smtp_sender_set: Boolean(c.smtp_admin_email),
  rate_limit_email_sent: c.rate_limit_email_sent ?? null,
  mailer_otp_exp: c.mailer_otp_exp ?? null,
  password_min_length: has("password_min_length") ? c.password_min_length : "FIELD NOT PRESENT",
  confirmation_template_uses_code: typeof c.mailer_templates_confirmation_content === "string"
    ? c.mailer_templates_confirmation_content.includes("{{ .Token }}") : null,
};
console.log("AUTH SETTINGS (read-only):");
for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${JSON.stringify(v)}`);
