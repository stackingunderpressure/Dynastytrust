# Mail sender for sign-up and reset codes (Resend)

**Why (2026-11-13).** A read-only check of the live project (workflow run
43467126830) found two things:

- `mailer_autoconfirm: true` -- every email sign-up is confirmed without
  proving the inbox, so anyone can make an account at an address they do not
  own, and an email-bound invite is not really bound to that person.
- No mail sender of its own (`smtp_host` empty). Supabase's built-in sender
  allows 2 emails an hour and delivers only to the project team's addresses,
  so password-reset codes very likely do not reach real users today either.

The operator chose to require the email code. That needs a real sender
first. The SMTP password is entered by the operator in the Supabase dashboard
and never passes through a chat or a Claude session.

Screen names below were correct when written. If a button has moved, look
for the same words nearby.

## 1. Resend account and domain (about 10 minutes plus DNS wait)

1. Go to resend.com and sign up.
2. **Domains -> Add Domain.** Enter `dynastytrust.family`. Pick the region
   closest to you.
3. Resend shows DNS records (an MX, a TXT for SPF and a TXT for DKIM, on a
   `send` or similar subdomain). Add each one, exactly as shown, wherever the
   domain's DNS lives (Netlify DNS if Netlify manages the domain: Netlify ->
   Domains -> dynastytrust.family -> DNS records -> Add new record).
   These records only let Resend send AS the domain; they do not touch the
   website.
4. Back in Resend, press **Verify**. Wait until the domain shows
   **Verified** (minutes to an hour).
5. **API Keys -> Create API Key.** Name it `supabase-auth`, permission
   **Sending access**, limited to `dynastytrust.family`. Copy the key. It is
   shown once. It goes ONLY into step 2 below -- not into chat, not into a
   file, not into GitHub.

## 2. Tell Supabase to use it

1. Supabase dashboard -> the DynastyTrust project -> **Authentication ->
   Emails -> SMTP Settings** -> turn on **Enable custom SMTP**.
2. Fill in:
   - Sender email: `no-reply@dynastytrust.family`
   - Sender name: `DynastyTrust`
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: the API key from step 1.5
3. **Save.**
4. **Authentication -> Rate Limits**: raise "emails sent per hour" from 2 to
   about 30, so a family signing up the same evening is not stopped.

Do NOT turn off "Confirm email" yourself. Say "sender is set up" and the
session does the rest, checked at every step.

## 3. What the session does next

1. Re-runs the read-only settings check: it must show `own_mail_sender: true`.
2. Sends one real code to an inbox you name (a password reset to your own
   account) and you confirm it arrived, so we know mail really flows before
   anyone depends on it.
3. With your OK, runs the hand-run **Supabase auth deploy**. It turns email
   confirmation on ONLY when the project has its own sender (the script
   checks and refuses otherwise), and sets Supabase's own password minimum
   to 12.
4. Walks a new email sign-up end to end: the account does not work until the
   emailed code is typed.

Not affected: username accounts and Tapit accounts (they are made by the
server, confirmed, and never mailed). Existing email accounts keep working.
