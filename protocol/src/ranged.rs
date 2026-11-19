//! Ranged ("v2") vault descriptors: one vault, many addresses.
//!
//! A v1 vault has one fixed address: every key is the `/0/0` child of its
//! account xpub, baked into the leaves. A v2 vault keeps the SAME policy --
//! the same leaves, quorums and timelocks, compiled by the same
//! `build_leaf_multileaf` -- but each key with an xpub becomes its BIP-389
//! multipath expression `[fp/path]xpub/<0;1>/*`. Receive addresses are
//! branch 0 (`/0/i`), change is branch 1 (`/1/i`). Everything after the one
//! compile is plain descriptor derivation, done by rust-miniscript.
//!
//! Built from the operator's proof of concept (branch poc/ranged-descriptors,
//! c1ce948; docs: dynastytrust-ranged-addresses-build-note). What changed from
//! the PoC, and why:
//!   * Keys are swapped by walking the parsed descriptor (miniscript's
//!     `Translator`), not by replacing hex substrings in its text.
//!   * Each xpub must derive, at /0/0, a key the compiled vault actually
//!     contains -- otherwise the "same vault" would quietly be a different
//!     one -- and receive/0 must equal the compiled (v1-style) address.
//!   * The internal key must be the unspendable NUMS point, so no address of
//!     the vault is ever key-path spendable.
//!   * Typed errors, bounded index ranges, checked arithmetic.
//!
//! Keys with no xpub (a Tapit key, which is a bare public key) stay FIXED at
//! every index. That is valid, but a path made only of fixed keys has the
//! same script at every address -- see the `tapit_only_path_*` tests for
//! exactly what that does and does not reveal.
//!
//! Not covered yet (deliberately): spending an `older()` ("if left
//! untouched") path from a ranged vault -- each coin would have its own
//! clock and `build_spend_psbt` only sets an absolute lock time.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::bip32::{ChildNumber, Fingerprint, DerivationPath, Xpub};
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use bitcoin::{Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};
use miniscript::descriptor::{DefiniteDescriptorKey, Descriptor, DescriptorPublicKey, SinglePubKey};
use miniscript::psbt::PsbtExt;
use miniscript::{translate_hash_clone, TranslateErr, TranslatePk, Translator};

use crate::policy_compiler::NUMS_HEX;
use crate::psbt_builder::DUST_LIMIT_SATS;

/// Highest non-hardened child index (BIP-32).
pub const MAX_INDEX: u32 = (1 << 31) - 1;
/// Most addresses derived in one call -- a caller scanning further asks again.
pub const MAX_ADDRESS_BATCH: u32 = 1000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RangedError {
    #[error("the compiled vault descriptor does not parse: {0}")]
    Template(String),
    #[error("the vault's internal key is not the unspendable NUMS point, so its addresses could be spent without any path's rules")]
    InternalKeyNotNums,
    #[error("key {0}: its xpub is for {1} but the vault is on {2}")]
    OriginNetwork(usize, String, String),
    #[error("key {0}: could not derive its first key (/0/0): {1}")]
    OriginDerive(usize, String),
    #[error("key {0}: its first key (/0/0) is not one of the compiled vault's keys")]
    OriginNotInVault(usize),
    #[error("keys {0} and {1} derive the same first key")]
    DuplicateOrigin(usize, usize),
    #[error("no key in the vault has an xpub, so every address would be the same -- this vault cannot be ranged")]
    NothingRanged,
    #[error("ranged descriptor: {0}")]
    Descriptor(String),
    #[error("receive address 0 ({got}) does not match the compiled vault's address ({want})")]
    Receive0Mismatch { got: String, want: String },
    #[error("address index {0} is past the last non-hardened index ({MAX_INDEX})")]
    Index(u64),
    #[error("asked for {0} addresses; at most {MAX_ADDRESS_BATCH} at a time")]
    Count(u32),
    #[error("spend: {0}")]
    Spend(String),
    #[error("not enough in the selected coins: {have} sats, need {need}")]
    Insufficient { have: u64, need: u64 },
}

type RResult<T> = std::result::Result<T, RangedError>;

/// Receive (`/0/*`) or change (`/1/*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Branch {
    Receive = 0,
    Change = 1,
}

/// Where one of the vault's keys comes from: the account xpub at
/// `[fingerprint/account_path]`. Its `/0/0` child must be a key the vault
/// was compiled with.
#[derive(Debug, Clone)]
pub struct KeyOrigin {
    pub fingerprint: Fingerprint,
    pub account_path: DerivationPath,
    pub xpub: Xpub,
}

impl KeyOrigin {
    fn first_key(&self, secp: &Secp256k1<bitcoin::secp256k1::VerifyOnly>) -> std::result::Result<XOnlyPublicKey, String> {
        let path = [ChildNumber::Normal { index: 0 }, ChildNumber::Normal { index: 0 }];
        let child = self.xpub.derive_pub(secp, &path).map_err(|e| e.to_string())?;
        Ok(child.public_key.x_only_public_key().0)
    }

    fn multipath(&self) -> std::result::Result<DescriptorPublicKey, String> {
        let path = self.account_path.to_string();
        let path = path.trim_start_matches('m');
        DescriptorPublicKey::from_str(&format!("[{}{}]{}/<0;1>/*", self.fingerprint, path, self.xpub)).map_err(|e| e.to_string())
    }
}

fn x_only(k: &DescriptorPublicKey) -> Option<XOnlyPublicKey> {
    match k {
        DescriptorPublicKey::Single(s) => Some(match s.key {
            SinglePubKey::FullKey(pk) => pk.inner.x_only_public_key().0,
            SinglePubKey::XOnly(x) => x,
        }),
        _ => None,
    }
}

/// Swaps each fixed key that has an origin for that origin's multipath key;
/// every other key (the NUMS internal key, a bare Tapit key) is kept as is.
struct ToRanged<'a> {
    by_key: &'a HashMap<XOnlyPublicKey, (usize, DescriptorPublicKey)>,
    used: HashSet<usize>,
}

impl Translator<DescriptorPublicKey, DescriptorPublicKey, ()> for ToRanged<'_> {
    fn pk(&mut self, pk: &DescriptorPublicKey) -> std::result::Result<DescriptorPublicKey, ()> {
        if let Some(x) = x_only(pk) {
            if let Some((i, ranged)) = self.by_key.get(&x) {
                self.used.insert(*i);
                return Ok(ranged.clone());
            }
        }
        Ok(pk.clone())
    }
    translate_hash_clone!(DescriptorPublicKey, DescriptorPublicKey, ());
}

fn same_network_kind(a: Network, b: Network) -> bool {
    (a == Network::Bitcoin) == (b == Network::Bitcoin)
}

/// A v2 vault: the multipath descriptor plus its two single-branch halves.
#[derive(Debug, Clone)]
pub struct RangedVault {
    network: Network,
    multipath: Descriptor<DescriptorPublicKey>,
    receive: Descriptor<DescriptorPublicKey>,
    change: Descriptor<DescriptorPublicKey>,
}

impl RangedVault {
    /// `template` is the descriptor `build_leaf_multileaf` compiled with each
    /// key's `/0/0` child (exactly what a v1 vault stores). Every origin must
    /// match one of those keys; keys with no origin stay fixed.
    pub fn from_template(template: &str, origins: &[KeyOrigin], network: Network) -> RResult<Self> {
        let template = Descriptor::<DescriptorPublicKey>::from_str(template).map_err(|e| RangedError::Template(e.to_string()))?;

        let nums = XOnlyPublicKey::from_slice(&hex::decode(NUMS_HEX).expect("NUMS hex")).expect("NUMS point");
        match &template {
            Descriptor::Tr(tr) if x_only(tr.internal_key()) == Some(nums) => {}
            _ => return Err(RangedError::InternalKeyNotNums),
        }
        if origins.is_empty() {
            return Err(RangedError::NothingRanged);
        }

        let secp = Secp256k1::verification_only();
        let mut by_key = HashMap::new();
        for (i, o) in origins.iter().enumerate() {
            if !same_network_kind(o.xpub.network, network) {
                return Err(RangedError::OriginNetwork(i, o.xpub.network.to_string(), network.to_string()));
            }
            let first = o.first_key(&secp).map_err(|e| RangedError::OriginDerive(i, e))?;
            let ranged = o.multipath().map_err(|e| RangedError::OriginDerive(i, e))?;
            if let Some((j, _)) = by_key.insert(first, (i, ranged)) {
                return Err(RangedError::DuplicateOrigin(j, i));
            }
        }

        let mut t = ToRanged { by_key: &by_key, used: HashSet::new() };
        let multipath = template.translate_pk(&mut t).map_err(|e| match e {
            TranslateErr::TranslatorErr(()) => RangedError::Descriptor("key translation failed".into()),
            TranslateErr::OuterError(e) => RangedError::Descriptor(e.to_string()),
        })?;
        if let Some(i) = (0..origins.len()).find(|i| !t.used.contains(i)) {
            return Err(RangedError::OriginNotInVault(i));
        }

        let mut halves = multipath.clone().into_single_descriptors().map_err(|e| RangedError::Descriptor(e.to_string()))?;
        if halves.len() != 2 {
            return Err(RangedError::Descriptor(format!("expected a receive and a change branch, got {}", halves.len())));
        }
        let change = halves.pop().expect("two halves");
        let receive = halves.pop().expect("two halves");
        let vault = RangedVault { network, multipath, receive, change };

        // Receive/0 IS the compiled vault: same keys, same tree.
        let want = template
            .at_derivation_index(0)
            .map_err(|e| RangedError::Template(e.to_string()))?
            .address(network)
            .map_err(|e| RangedError::Template(e.to_string()))?
            .to_string();
        let got = vault.address(Branch::Receive, 0)?;
        if got != want {
            return Err(RangedError::Receive0Mismatch { got, want });
        }
        Ok(vault)
    }

    pub fn network(&self) -> Network {
        self.network
    }

    /// The `<0;1>/*` descriptor, with checksum.
    pub fn multipath_descriptor(&self) -> String {
        self.multipath.to_string()
    }

    /// The `/0/*` and `/1/*` descriptors, with checksums -- the form every
    /// Bitcoin Core version imports.
    pub fn branch_descriptor(&self, branch: Branch) -> String {
        match branch {
            Branch::Receive => self.receive.to_string(),
            Branch::Change => self.change.to_string(),
        }
    }

    /// The concrete descriptor for one address.
    pub fn definite(&self, branch: Branch, index: u32) -> RResult<Descriptor<DefiniteDescriptorKey>> {
        if index > MAX_INDEX {
            return Err(RangedError::Index(index as u64));
        }
        let d = match branch {
            Branch::Receive => &self.receive,
            Branch::Change => &self.change,
        };
        d.at_derivation_index(index).map_err(|e| RangedError::Descriptor(e.to_string()))
    }

    pub fn address(&self, branch: Branch, index: u32) -> RResult<String> {
        Ok(self.definite(branch, index)?.address(self.network).map_err(|e| RangedError::Descriptor(e.to_string()))?.to_string())
    }

    /// `count` addresses from `start` on one branch.
    pub fn addresses(&self, branch: Branch, start: u32, count: u32) -> RResult<Vec<String>> {
        if count > MAX_ADDRESS_BATCH {
            return Err(RangedError::Count(count));
        }
        if count > 0 && start as u64 + count as u64 - 1 > MAX_INDEX as u64 {
            return Err(RangedError::Index(start as u64 + count as u64 - 1));
        }
        (start..start + count).map(|i| self.address(branch, i)).collect()
    }

    /// An unsigned PSBT spending coins from any of the vault's addresses,
    /// with change (if above dust) to `change_index` on the change branch.
    /// rust-miniscript fills each input's internal key, merkle root, every
    /// leaf script with its control block, and per-index key origins
    /// (`fp/path/<branch>/<index>`); the change output gets the same, so a
    /// signer can prove it is the vault's own change.
    ///
    /// `lock_time_height` is the absolute height for an `after()` path (0
    /// for a path that opens right away). `older()` paths are not supported
    /// here yet.
    pub fn build_spend_psbt(
        &self,
        inputs: &[RangedInput],
        destination: &str,
        amount_sats: u64,
        fee_sats: u64,
        change_index: u32,
        lock_time_height: u32,
    ) -> RResult<Psbt> {
        if inputs.is_empty() {
            return Err(RangedError::Spend("no coins selected".into()));
        }
        let have = inputs.iter().try_fold(0u64, |a, i| a.checked_add(i.value_sats)).ok_or_else(|| RangedError::Spend("input total overflows".into()))?;
        let need = amount_sats.checked_add(fee_sats).ok_or_else(|| RangedError::Spend("amount plus fee overflows".into()))?;
        let change = have.checked_sub(need).ok_or(RangedError::Insufficient { have, need })?;
        if amount_sats < DUST_LIMIT_SATS {
            return Err(RangedError::Spend(format!("amount {amount_sats} sats is below dust ({DUST_LIMIT_SATS})")));
        }
        let dest = Address::from_str(destination)
            .map_err(|e| RangedError::Spend(format!("destination: {e}")))?
            .require_network(self.network)
            .map_err(|e| RangedError::Spend(format!("destination: {e}")))?;

        let change_desc = self.definite(Branch::Change, change_index)?;
        let mut outputs = vec![TxOut { value: Amount::from_sat(amount_sats), script_pubkey: dest.script_pubkey() }];
        // Below dust, the remainder goes to the fee, as on v1 (psbt_builder).
        let has_change = change >= DUST_LIMIT_SATS;
        if has_change {
            outputs.push(TxOut { value: Amount::from_sat(change), script_pubkey: change_desc.script_pubkey() });
        }
        let lock_time = if lock_time_height > 0 {
            LockTime::from_height(lock_time_height).map_err(|e| RangedError::Spend(format!("lock time: {e}")))?
        } else {
            LockTime::ZERO
        };
        let tx_inputs = inputs
            .iter()
            .map(|i| {
                Ok(TxIn {
                    previous_output: OutPoint { txid: Txid::from_str(&i.txid).map_err(|e| RangedError::Spend(format!("txid {}: {e}", i.txid)))?, vout: i.vout },
                    script_sig: ScriptBuf::new(),
                    // Non-final, so an after() lock time is enforced.
                    sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                    witness: Witness::default(),
                })
            })
            .collect::<RResult<Vec<_>>>()?;
        let tx = Transaction { version: bitcoin::transaction::Version::TWO, lock_time, input: tx_inputs, output: outputs };

        let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| RangedError::Spend(e.to_string()))?;
        for (n, i) in inputs.iter().enumerate() {
            let d = self.definite(i.branch, i.index)?;
            psbt.inputs[n].witness_utxo = Some(TxOut { value: Amount::from_sat(i.value_sats), script_pubkey: d.script_pubkey() });
            psbt.update_input_with_descriptor(n, &d).map_err(|e| RangedError::Spend(format!("input {n}: {e:?}")))?;
        }
        if has_change {
            psbt.update_output_with_descriptor(1, &change_desc).map_err(|e| RangedError::Spend(format!("change: {e:?}")))?;
        }
        Ok(psbt)
    }
}

/// One coin to spend: where it is, and which of the vault's addresses holds it.
#[derive(Debug, Clone)]
pub struct RangedInput {
    pub txid: String,
    pub vout: u32,
    pub value_sats: u64,
    pub branch: Branch,
    pub index: u32,
}
