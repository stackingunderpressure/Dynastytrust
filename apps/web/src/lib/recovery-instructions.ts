// How to recover a vault with this app gone -- ONE source for the words,
// used by every backup file this app writes (descriptor-backup.ts).
//
// 2026-11-11: until today every backup named Sparrow as "the recommended
// recovery path" and said Sparrow would set the timelock for you. Nobody
// had seen Sparrow load one of these vaults, and its release notes say it
// rejects a Taproot descriptor with a script tree. What HAS been seen is
// Bitcoin Core: scripts/bitcoin-core-proof.mjs loads a vault from the real
// compiler into Bitcoin Core 32.1 on a private chain and spends it with
// Core alone, following the numbered steps below exactly. Only commands
// that proof ran are printed here. Change these words only together with
// that proof.

/** The bitcoin-cli network flag for a vault's network ('' on mainnet). */
export function coreNetworkFlag(network: string): string {
  if (network === 'signet') return ' -signet';
  if (network === 'testnet') return ' -testnet';
  return '';
}

/** Plain lines, no comment prefix. `heightsAre` says where the document
 *  holding them lists the block heights. */
export function coreRecoveryLines(network: string, heightsAre = 'listed above'): string[] {
  const cli = `bitcoin-cli${coreNetworkFlag(network)}`;
  return [
    `BITCOIN CORE (the proven way):`,
    `  On 11 November 2026 a vault made by this app was loaded into`,
    `  Bitcoin Core 32.1 on a private test chain, showed the same`,
    `  address, and was spent with Bitcoin Core alone. Use version 29`,
    `  or newer, fully synced and not pruned.`,
    `  1. Get the descriptor's checksum:`,
    `       ${cli} getdescriptorinfo "DESCRIPTOR"`,
    `  2. Make a watch-only wallet:`,
    `       ${cli} createwallet "vault" true true`,
    `  3. Load the vault (this scans the whole chain and takes time):`,
    `       ${cli} -rpcwallet=vault importdescriptors`,
    `         '[{"desc":"DESCRIPTOR#CHECKSUM","timestamp":0}]'`,
    `  4. See the coins:`,
    `       ${cli} -rpcwallet=vault listunspent`,
    ``,
    `TO SPEND:`,
    `  Bitcoin Core does not read seed words. Each signer either signs`,
    `  on a hardware wallet that supports Taproot miniscript (we have`,
    `  not tested one), or, on a computer that is OFFLINE, turns their`,
    `  words into the account private key for the path printed beside`,
    `  their key, puts it into the descriptor in place of their own`,
    `  public key (keep the [bracket] in front of it and the /0/0`,
    `  after it), and loads that into a wallet of their own:`,
    `       ${cli} createwallet "signer" false true`,
    `       then importdescriptors as in step 3.`,
    `  This needs someone comfortable with a command line. Get help`,
    `  from a person you trust before typing seed words anywhere.`,
    `  5. Write the transaction:`,
    `       ${cli} createpsbt`,
    `         '[{"txid":"TXID","vout":N,"sequence":4294967294}]'`,
    `         '[{"DESTINATION":AMOUNT}]' LOCKTIME`,
    `     AMOUNT is the coin's amount minus the fee you choose.`,
    `  6. Each signer, in their own wallet:`,
    `       ${cli} -rpcwallet=signer walletprocesspsbt "PSBT"`,
    `  7. Put the signed copies together:`,
    `       ${cli} combinepsbt '["PSBT1","PSBT2"]'`,
    `  8. ${cli} finalizepsbt "COMBINED"`,
    `     It must answer "complete": true. If not, a signature or the`,
    `     locktime is missing.`,
    `  9. ${cli} sendrawtransaction "HEX"`,
    ``,
    `TIMELOCKED PATHS:`,
    `  Nothing sets the locktime for you. LOCKTIME in step 5 is 0 for`,
    `  a path that is open now. For a dated path it must be that`,
    `  path's block height ${heightsAre}, and the network refuses the`,
    `  transaction until that block has passed. An "if untouched"`,
    `  path uses the coin's sequence number instead of the locktime;`,
    `  we have not tested that one in Bitcoin Core.`,
    ``,
    `SPARROW:`,
    `  We have not seen Sparrow load this kind of vault, and its`,
    `  release notes say it does not accept it. Do not count on it.`,
    ``,
    `NUNCHUK:`,
    `  Nunchuk supports this kind of vault in principle, but expects a`,
    `  different descriptor form than this file holds. We have not`,
    `  seen it load one. Do not count on it.`,
  ];
}

/**
 * The same, for a vault with a NEW ADDRESS EVERY TIME (ranged addresses,
 * descriptor `<0;1>/*`). Every command here is run, in this order, by
 * scripts/bitcoin-core-ranged-proof.mjs against Bitcoin Core 32.1 (seen
 * 24 November 2026): one watch-only import of the one descriptor sees coins
 * on many receive and change addresses; two people spend with Core alone;
 * the "if left untouched" path is spent with the sequence as the wait.
 * Change these words only together with that proof.
 */
export function coreRangedRecoveryLines(network: string, heightsAre = 'listed above'): string[] {
  const cli = `bitcoin-cli${coreNetworkFlag(network)}`;
  return [
    `BITCOIN CORE (the proven way):`,
    `  This vault gives every payment a new address. On 24 November 2026`,
    `  a vault like it was loaded into Bitcoin Core 32.1 on a private`,
    `  test chain from this ONE descriptor, showed coins on many of its`,
    `  addresses, and was spent with Bitcoin Core alone. Use version 29`,
    `  or newer, fully synced and not pruned.`,
    `  1. Make a watch-only wallet:`,
    `       ${cli} createwallet "vault" true true`,
    `  2. Load the vault (the descriptor above already ends in its`,
    `     checksum; this scans the whole chain and takes time):`,
    `       ${cli} -rpcwallet=vault importdescriptors`,
    `         '[{"desc":"DESCRIPTOR","timestamp":0,"range":[0,999],"active":true}]'`,
    `  3. See the coins, on every address of the vault:`,
    `       ${cli} -rpcwallet=vault listunspent`,
    ``,
    `TO SPEND:`,
    `  Bitcoin Core does not read seed words. Each signer either signs`,
    `  on a hardware wallet that supports Taproot miniscript (we have`,
    `  not tested one), or, on a computer that is OFFLINE, turns their`,
    `  words into the account private key for the path printed beside`,
    `  their key, puts it into the descriptor in place of their own`,
    `  public key (keep the [bracket] in front of it and the /<0;1>/*`,
    `  after it), drops the old #checksum, gets the new one with`,
    `       ${cli} getdescriptorinfo "EDITED DESCRIPTOR"`,
    `  and loads it into a wallet of their own:`,
    `       ${cli} createwallet "signer" false true`,
    `       then importdescriptors as in step 2, with the new checksum.`,
    `  This needs someone comfortable with a command line. Get help`,
    `  from a person you trust before typing seed words anywhere.`,
    `  4. Write the transaction (one or more coins from step 3):`,
    `       ${cli} createpsbt`,
    `         '[{"txid":"TXID","vout":N,"sequence":4294967294}]'`,
    `         '[{"DESTINATION":AMOUNT}]' LOCKTIME`,
    `     AMOUNT is the coins' total minus the fee you choose.`,
    `  5. Each signer, in their own wallet:`,
    `       ${cli} -rpcwallet=signer walletprocesspsbt "PSBT"`,
    `  6. Put the signed copies together:`,
    `       ${cli} combinepsbt '["PSBT1","PSBT2"]'`,
    `  7. ${cli} finalizepsbt "COMBINED"`,
    `     It must answer "complete": true. If not, a signature or the`,
    `     lock is missing.`,
    `  8. ${cli} sendrawtransaction "HEX"`,
    ``,
    `TIMELOCKED PATHS:`,
    `  Nothing sets the lock for you. LOCKTIME in step 4 is 0 for a`,
    `  path that is open now. For a dated path it must be that path's`,
    `  block height ${heightsAre}, and the network refuses the`,
    `  transaction until that block has passed. For an "if untouched"`,
    `  path, LOCKTIME is 0 and each coin's "sequence" is the path's`,
    `  number of blocks instead of 4294967294; the network refuses it`,
    `  until that coin has sat that many blocks. Tested in Bitcoin Core.`,
    ``,
    `SPARROW:`,
    `  We have not seen Sparrow load this kind of vault, and its`,
    `  release notes say it does not accept it. Do not count on it.`,
    ``,
    `NUNCHUK:`,
    `  Nunchuk works with many-address descriptors like this one in`,
    `  principle, but we have not seen it load one of these vaults.`,
    `  Do not count on it.`,
  ];
}
