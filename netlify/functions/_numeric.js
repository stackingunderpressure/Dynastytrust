// Number bounds for request fields (amounts, fee rates, quorums) live in
// packages/vault-rules, ONE copy shared with the downloaded app; re-exported
// here so every function keeps importing them from ./_numeric.js.
export { isFiniteNumber, MIN_FEE_RATE_SAT_VB, MAX_FEE_RATE_SAT_VB, checkNumberBounds } from "../../packages/vault-rules/src/numeric.js";
