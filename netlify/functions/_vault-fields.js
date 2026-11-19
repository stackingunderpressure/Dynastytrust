// The vault columns every route hands back to the app as "the vault".
// The app keeps what a route returns and opens the vault page with it
// (VaultWizard's "Open vault" passes it as the page's starting state), so a
// route that returns fewer columns than this leaves the page reading key
// lists that are not there. compile-leaves.js and vaults-compile-bloc.js
// once returned a short list and the page crashed right after the wizard
// (live signet walk, 2026-11-19: "TypeError: e is not iterable").
export const VAULT_FIELDS =
  "id, created_at, updated_at, user_id, name, network, address, descriptor, miniscript_policy, address_type, founder_quorum, heir_quorum, recovery_quorum, recovery_after, inheritance_after, founder_keys, heir_keys, protector_keys, protector_quorum, protector_after, consent_keys, consent_quorum, archived, status, planned_founder_count, planned_heir_count, trust_doc, predecessor_id, duress, bloc_policy, leaf_scripts, backup_keys, backup_quorum, second_heir_keys, second_heir_quorum, second_inheritance_after, key_labels, leaves, key_origins";
