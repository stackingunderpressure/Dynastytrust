-- ============================================================
-- 035_circle_phrase_delivery_confirm.sql
-- Real receipt confirmation for the circle safety phrase pair (operator,
-- looking at the still-unlocked Send card: "if you forget you can resend
-- and it save over the other one? But message couldn't drop in that
-- situation").
--
-- 034_circle_phrase_deliveries.sql's `status` only ever reflected
-- whether a Nostr RELAY accepted the publish -- never whether the
-- recipient's Tapit wallet actually received and stored the phrase. A
-- relay can accept an event that the intended wallet never sees (it was
-- offline, its subscription hadn't started yet, decrypt failed for a
-- rotated key, etc.), so "Sent" alone was a real gap: it could read
-- true while the phrase silently never landed. `confirmed_at` is set
-- only once the recipient's own wallet round-trips a real
-- acknowledgment back over Nostr (kind 9581,
-- circle-phrase-ack-channel.ts) after successfully storing the pair --
-- see that file's header. `reply_pubkey`/`reply_privkey` are the same
-- ephemeral-messaging-keypair pattern 033_vault_membership_grants.sql
-- already established: not a Bitcoin key, persisted so the ack can still
-- be decrypted even if the tab that sent the phrase has long since
-- closed. Nullable so a row from before this migration (or a delivery
-- whose send failed before an ack channel could be minted) degrades
-- gracefully to "no confirmation available" rather than erroring.
-- ============================================================

alter table circle_phrase_deliveries
  add column if not exists reply_pubkey  text,
  add column if not exists reply_privkey text,
  add column if not exists confirmed_at  timestamptz;

create index if not exists circle_phrase_deliveries_reply_pubkey_idx
  on circle_phrase_deliveries(reply_pubkey);
