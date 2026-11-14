// The must-sign check lives in packages/vault-rules, ONE copy shared with
// the downloaded app; re-exported here so callers keep this import path.
export { mustSignPathsNotInScripts } from "../../packages/vault-rules/src/must-sign.js";
