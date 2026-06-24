import { secp256k1 } from '@noble/curves/secp256k1.js';
import { chacha20 } from '@noble/ciphers/chacha.js';
import { hmac } from '@noble/hashes/hmac.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha256.js';
import {
  hexToBytes,
  isHex,
  randomBytes,
  utf8ToBytes,
} from '../internal.js';

// NIP-44 v2 — encrypted payload for one peer. The Phase 5c Nostr
// transport in the Tapit Wallet uses this so a signed envelope can
// travel through relays that must see ciphertext only. Implemented
// against the NIP-44 v2 spec so encrypted messages are
// interoperable with the wider Nostr world (D-06: Nostr is the
// decided transport substrate; key-pair compatible by construction).
//
// Construction (per NIP-44 v2):
//   shared_x         = ECDH(senderPriv, recipientPub_lifted).X
//   conversation_key = HKDF-Extract(SHA-256, salt='nip44-v2', ikm=shared_x)
//   nonce            = random 32 bytes per message
//   key_material     = HKDF-Expand(SHA-256, conversation_key, info=nonce, L=76)
//   chacha_key       = key_material[0..32]
//   chacha_nonce     = key_material[32..44]
//   hmac_key         = key_material[44..76]
//   padded_plaintext = u16_be(len(pt)) || pt || zeros(padded_len - len(pt))
//   ciphertext       = ChaCha20(chacha_key, chacha_nonce, padded_plaintext)
//   mac              = HMAC-SHA256(hmac_key, nonce || ciphertext)
//   payload          = base64( 0x02 || nonce(32) || ciphertext || mac(32) )

const VERSION = 0x02;
const NONCE_LEN = 32;
const MAC_LEN = 32;
const KEY_MATERIAL_LEN = 76;
const SALT = utf8ToBytes('nip44-v2');
const MIN_PLAINTEXT_LEN = 1;
const MAX_PLAINTEXT_LEN = 65_535;

function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower >>> 3;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function padPlaintext(plaintext: Uint8Array): Uint8Array {
  const len = plaintext.length;
  if (len < MIN_PLAINTEXT_LEN || len > MAX_PLAINTEXT_LEN) {
    throw new Error(
      `plaintext length must be ${MIN_PLAINTEXT_LEN}..${MAX_PLAINTEXT_LEN} bytes`,
    );
  }
  const paddedLen = calcPaddedLen(len);
  const out = new Uint8Array(2 + paddedLen);
  out[0] = (len >>> 8) & 0xff;
  out[1] = len & 0xff;
  out.set(plaintext, 2);
  return out;
}

function unpadPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < 2) throw new Error('padded plaintext is too short');
  const len = (padded[0]! << 8) | padded[1]!;
  if (len < MIN_PLAINTEXT_LEN || len > MAX_PLAINTEXT_LEN) {
    throw new Error('invalid plaintext length prefix');
  }
  if (padded.length !== 2 + calcPaddedLen(len)) {
    throw new Error('padded length does not match the length prefix');
  }
  return padded.subarray(2, 2 + len);
}

// BIP340 x-only pubkey (32 bytes, even-Y by convention) → 33-byte
// SEC1-compressed point with the even-Y prefix, as NIP-44 v2 specifies
// for the ECDH peer-public side.
function liftXOnly(xOnly: Uint8Array): Uint8Array {
  const out = new Uint8Array(33);
  out[0] = 0x02;
  out.set(xOnly, 1);
  return out;
}

function conversationKey(
  privKey: Uint8Array,
  peerPubKey: Uint8Array,
): Uint8Array {
  const shared = secp256k1.getSharedSecret(privKey, liftXOnly(peerPubKey));
  const sharedX = shared.subarray(1, 33);
  return extract(sha256, sharedX, SALT);
}

function macMessage(
  hmacKey: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const data = new Uint8Array(nonce.length + ciphertext.length);
  data.set(nonce, 0);
  data.set(ciphertext, nonce.length);
  return hmac(sha256, hmacKey, data);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  let s: string;
  try {
    s = atob(b64);
  } catch {
    throw new Error('payload is not valid base64');
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Encrypt a string to a recipient's x-only public key using NIP-44 v2.
 * Returns a base64-encoded payload safe for any Nostr-event content
 * field — relays cannot read the plaintext, only the recipient can.
 */
export function encryptTo(
  plaintext: string,
  recipientPubkey: string,
  senderPrivkey: string,
): string {
  if (!isHex(recipientPubkey, 32)) {
    throw new Error('recipientPubkey must be 32-byte hex');
  }
  if (!isHex(senderPrivkey, 32)) {
    throw new Error('senderPrivkey must be 32-byte hex');
  }
  const priv = hexToBytes(senderPrivkey);
  const pub = hexToBytes(recipientPubkey);
  const nonce = randomBytes(NONCE_LEN);
  const padded = padPlaintext(utf8ToBytes(plaintext));
  const prk = conversationKey(priv, pub);
  const material = expand(sha256, prk, nonce, KEY_MATERIAL_LEN);
  const chachaKey = material.subarray(0, 32);
  const chachaNonce = material.subarray(32, 44);
  const hmacKey = material.subarray(44, 76);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = macMessage(hmacKey, nonce, ciphertext);
  const out = new Uint8Array(1 + NONCE_LEN + ciphertext.length + MAC_LEN);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(ciphertext, 1 + NONCE_LEN);
  out.set(mac, 1 + NONCE_LEN + ciphertext.length);
  return bytesToBase64(out);
}

/**
 * Decrypt a NIP-44 v2 payload that came from a sender's x-only
 * public key. Throws if the MAC does not verify — that catches a
 * tampered payload, a wrong-sender claim, or a wrong recipient — or
 * if the payload is malformed.
 */
export function decryptFrom(
  payload: string,
  senderPubkey: string,
  recipientPrivkey: string,
): string {
  if (!isHex(senderPubkey, 32)) {
    throw new Error('senderPubkey must be 32-byte hex');
  }
  if (!isHex(recipientPrivkey, 32)) {
    throw new Error('recipientPrivkey must be 32-byte hex');
  }
  const bytes = base64ToBytes(payload);
  // Minimum: version(1) + nonce(32) + ciphertext(34 for the smallest
  // valid padded plaintext of 1 byte) + mac(32) = 99 bytes.
  if (bytes.length < 1 + NONCE_LEN + 34 + MAC_LEN) {
    throw new Error('payload too short');
  }
  if (bytes[0] !== VERSION) throw new Error('unsupported NIP-44 version');
  const nonce = bytes.subarray(1, 1 + NONCE_LEN);
  const ciphertext = bytes.subarray(1 + NONCE_LEN, bytes.length - MAC_LEN);
  const mac = bytes.subarray(bytes.length - MAC_LEN);
  const priv = hexToBytes(recipientPrivkey);
  const pub = hexToBytes(senderPubkey);
  const prk = conversationKey(priv, pub);
  const material = expand(sha256, prk, nonce, KEY_MATERIAL_LEN);
  const chachaKey = material.subarray(0, 32);
  const chachaNonce = material.subarray(32, 44);
  const hmacKey = material.subarray(44, 76);
  const expectedMac = macMessage(hmacKey, nonce, ciphertext);
  if (!constantTimeEqual(expectedMac, mac)) {
    throw new Error(
      'MAC verification failed — wrong sender, wrong recipient, or tampered payload',
    );
  }
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return new TextDecoder().decode(unpadPlaintext(padded));
}
