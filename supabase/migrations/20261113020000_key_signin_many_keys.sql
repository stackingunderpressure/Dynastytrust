-- ============================================================
-- Email-free sign-in, slice 1 (docs/key-signin-build-note.md).
-- Operator, 2026-11-13: "never have an email and only sign in with your
-- key ... it can still be hooked to the Supabase".
--
-- wallet_identities held ONE key per account (user_id was the primary
-- key). An account now holds several sign-in keys: this phone's key made
-- from the person's 24 words, later a hardware wallet, and a linked Tapit
-- wallet. Each row gets its own id, a kind and a label. pubkey stays
-- globally unique (one key, one account). Existing rows become kind
-- 'tapit' -- every row today came from a Tapit link.
-- Idempotent: safe to run twice.
-- ============================================================

alter table wallet_identities add column if not exists id uuid not null default gen_random_uuid();
alter table wallet_identities add column if not exists kind text not null default 'tapit';
alter table wallet_identities add column if not exists label text;

do $$
declare pk text;
begin
  select conname into pk from pg_constraint
   where conrelid = 'public.wallet_identities'::regclass and contype = 'p'
     and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id)';
  if pk is not null then
    execute format('alter table public.wallet_identities drop constraint %I', pk);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.wallet_identities'::regclass and contype = 'p') then
    alter table public.wallet_identities add primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.wallet_identities'::regclass and conname = 'wallet_identities_kind_check') then
    alter table public.wallet_identities add constraint wallet_identities_kind_check check (kind in ('tapit', 'device', 'hardware'));
  end if;
end $$;

create index if not exists wallet_identities_user_idx on wallet_identities(user_id);
-- At most one linked Tapit wallet per account, as before.
create unique index if not exists wallet_identities_one_tapit on wallet_identities(user_id) where kind = 'tapit';

notify pgrst, 'reload schema';
