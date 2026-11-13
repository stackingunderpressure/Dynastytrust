//! Re-derive a vault's address from its stored descriptor, in the browser.
//!
//! The phone stops trusting the server's word for where the money goes:
//! every time a vault opens, its descriptor is compiled HERE, by the same
//! rust-miniscript the Fly compiler uses, and the address it produces is
//! compared with the stored one (apps/web/src/lib/descriptor-check.ts).
//!
//! No wasm-bindgen: three plain exported functions over linear memory, so
//! the JavaScript loader is a few auditable lines and there is no
//! generated glue whose version must match. Strings go in as UTF-8 bytes
//! the caller writes into memory from `alloc`; the answer comes back as a
//! pointer to [len: u32 little-endian][UTF-8 JSON], freed with `dealloc`.

use std::str::FromStr;

use bitcoin::Network;
use miniscript::descriptor::{Descriptor, DescriptorPublicKey};

/// The address a descriptor pays to, for the network named the way
/// DynastyTrust stores it ('bitcoin' | 'testnet' | 'signet'; 'mainnet'
/// accepted as 'bitcoin'). Index 0: every DynastyTrust key is a fixed
/// `/0/0` child; an older ranged `/0/*` descriptor gives that same child.
pub fn descriptor_address(descriptor: &str, network: &str) -> Result<String, String> {
    let net = match network {
        "bitcoin" | "mainnet" => Network::Bitcoin,
        "testnet" => Network::Testnet,
        "signet" => Network::Signet,
        "regtest" => Network::Regtest,
        other => return Err(format!("unknown network '{other}'")),
    };
    // A trailing #checksum is dropped, not checked: the app itself
    // rewrites stored descriptors into key-origin form ([fp/path]xpub/0/0,
    // descriptor-keys.ts upgradeDescriptor), which leaves a wsh vault's
    // checksum stale. What protects the money is the comparison with the
    // stored address, which the caller always makes.
    let body = descriptor.trim().split('#').next().unwrap_or("");
    let desc = Descriptor::<DescriptorPublicKey>::from_str(body)
        .map_err(|e| format!("the descriptor does not parse: {e}"))?;
    let definite = desc
        .at_derivation_index(0)
        .map_err(|e| format!("the descriptor cannot be made definite: {e}"))?;
    let address = definite
        .address(net)
        .map_err(|e| format!("the descriptor has no address: {e}"))?;
    Ok(address.to_string())
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Reserve `len` bytes for the caller to write into.
#[no_mangle]
pub extern "C" fn dt_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Give back memory from `dt_alloc` or from an answer.
///
/// # Safety
/// `ptr` and `cap` must be exactly what `dt_alloc` returned / was given,
/// or an answer pointer with cap = 4 + its stored length.
#[no_mangle]
pub unsafe extern "C" fn dt_dealloc(ptr: *mut u8, cap: usize) {
    drop(Vec::from_raw_parts(ptr, 0, cap.max(1)));
}

/// `{"ok":true,"address":"..."}` or `{"ok":false,"error":"..."}`.
///
/// # Safety
/// The two (ptr, len) pairs must point at caller-written UTF-8 bytes.
#[no_mangle]
pub unsafe extern "C" fn dt_descriptor_address(
    desc_ptr: *const u8,
    desc_len: usize,
    net_ptr: *const u8,
    net_len: usize,
) -> *mut u8 {
    let read = |p: *const u8, n: usize| -> Result<String, String> {
        String::from_utf8(std::slice::from_raw_parts(p, n).to_vec()).map_err(|_| "input is not UTF-8".to_string())
    };
    let json = match read(desc_ptr, desc_len)
        .and_then(|d| read(net_ptr, net_len).map(|n| (d, n)))
        .and_then(|(d, n)| descriptor_address(&d, &n))
    {
        Ok(a) => format!("{{\"ok\":true,\"address\":\"{}\"}}", json_escape(&a)),
        Err(e) => format!("{{\"ok\":false,\"error\":\"{}\"}}", json_escape(&e)),
    };
    let bytes = json.into_bytes();
    let mut out = Vec::<u8>::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&bytes);
    let ptr = out.as_mut_ptr();
    std::mem::forget(out);
    ptr
}

#[cfg(test)]
mod tests {
    use super::*;

    // BIP 86 test vector: tr() of the first receive key of
    // "abandon x11 about" at m/86'/0'/0'/0/0.
    const BIP86_XPUB: &str = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
    const BIP86_ADDR: &str = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

    #[test]
    fn bip86_vector() {
        let d = format!("tr([73c5da0a/86'/0'/0']{BIP86_XPUB}/0/0)");
        assert_eq!(descriptor_address(&d, "bitcoin").unwrap(), BIP86_ADDR);
        // A ranged descriptor gives the same index-0 child.
        let r = format!("tr([73c5da0a/86'/0'/0']{BIP86_XPUB}/0/*)");
        assert_eq!(descriptor_address(&r, "bitcoin").unwrap(), BIP86_ADDR);
    }

    #[test]
    fn refuses_garbage_ignores_stale_checksum() {
        assert!(descriptor_address("tr(nonsense)", "signet").is_err());
        // A stale checksum is ignored; the address must still be right.
        let d = format!("tr([73c5da0a/86'/0'/0']{BIP86_XPUB}/0/0)#aaaaaaaa");
        assert_eq!(descriptor_address(&d, "bitcoin").unwrap(), BIP86_ADDR);
        assert!(descriptor_address(&format!("tr({BIP86_XPUB}/0/0)"), "litecoin").is_err());
    }

    #[test]
    fn ffi_round_trip() {
        let d = format!("tr([73c5da0a/86'/0'/0']{BIP86_XPUB}/0/0)");
        unsafe {
            let p = dt_descriptor_address(d.as_ptr(), d.len(), b"bitcoin".as_ptr(), 7);
            let len = u32::from_le_bytes(std::slice::from_raw_parts(p, 4).try_into().unwrap()) as usize;
            let s = std::str::from_utf8(std::slice::from_raw_parts(p.add(4), len)).unwrap().to_string();
            dt_dealloc(p, 4 + len);
            assert_eq!(s, format!("{{\"ok\":true,\"address\":\"{BIP86_ADDR}\"}}"));
        }
    }
}
