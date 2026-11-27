// Types shared by the Send screen (SendTab.tsx) and its three screens.
import type { LocalKey } from "../../lib/keystore";

export type BlocPath = "parents_now" | "coparent_kids" | "parent_solo" | "kids_decay";

export interface SigningState {
  psbt_hex: string;
  psbt_b64: string;
  summary: {
    amount_sats: number;
    fee_sats: number;
    change_sats: number;
    fee_rate: number;
    destination: string;
  };
  proposal_id?: string;
  signers: Array<{ key: LocalKey; status: "pending" | "signing" | "signed" | "error"; error?: string }>;
  signaturesCollected: number;
  requiredSignatures: number;
  txid?: string;
}
