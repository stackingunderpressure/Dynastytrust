create table if not exists keys (
  id uuid primary key,
  user_id text not null,
  label text not null,
  origin text not null check (origin in ('software', 'hardware', 'imported_xpub')),
  network text not null check (network in ('testnet', 'mainnet')),
  curve text not null default 'secp256k1',
  fingerprint text,
  derivation_path text,
  xpub text,
  pubkey text not null,
  encrypted_private_blob jsonb,
  can_backend_sign boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived', 'compromised')),
  created_at timestamptz not null default now()
);
