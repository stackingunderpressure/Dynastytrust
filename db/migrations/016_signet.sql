-- ============================================================
-- 016_signet.sql
-- Allow 'signet' as a valid value for the `network` column on
-- vaults and distribution_wallets. Bitcoin Core treats signet and
-- testnet as the same coin_type for derivation; we just need the
-- check constraints to accept it so mempool.space/signet/* calls
-- validate cleanly.
-- ============================================================

alter table vaults drop constraint if exists vaults_network_check;
alter table vaults
  add constraint vaults_network_check
  check (network in ('testnet', 'signet', 'bitcoin'));

alter table distribution_wallets drop constraint if exists distribution_wallets_network_check;
alter table distribution_wallets
  add constraint distribution_wallets_network_check
  check (network in ('testnet', 'signet', 'bitcoin'));
