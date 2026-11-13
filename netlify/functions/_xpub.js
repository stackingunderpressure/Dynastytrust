// Extended-public-key helpers (refuse a private key; xpub -> its /0/0
// pubkey) live in packages/vault-rules, ONE copy shared with the downloaded
// app; re-exported here so every function keeps importing ./_xpub.js.
export * from "../../packages/vault-rules/src/xpub.js";
