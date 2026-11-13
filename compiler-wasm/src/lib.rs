//! The DynastyTrust vault compiler, in the browser (sovereign slice 1).
//!
//! One function: every compiler endpoint, by name, answered by
//! `dynastytrust_protocol::service::handle` -- the same code the Fly server
//! runs behind its shared secret. Request JSON in; `{"status":..,"body":..}`
//! out, where `status` and `body` are exactly what the server would send.
//!
//! No wasm-bindgen, same as protocol-wasm/: plain exported functions over
//! linear memory. Strings go in as UTF-8 bytes the caller writes into memory
//! from `dt_alloc`; the answer comes back as a pointer to
//! [len: u32 little-endian][UTF-8 JSON], freed with `dt_dealloc`.

use dynastytrust_protocol::service;

/// `{"status": <http status>, "body": "<the server's response JSON>"}`.
pub fn handle(endpoint: &str, body: &str) -> String {
    let (status, body) = service::handle(endpoint, body);
    serde_json::json!({ "status": status, "body": body }).to_string()
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

/// Answer one compiler request.
///
/// # Safety
/// The two (ptr, len) pairs must point at caller-written bytes.
#[no_mangle]
pub unsafe extern "C" fn dt_handle(ep_ptr: *const u8, ep_len: usize, body_ptr: *const u8, body_len: usize) -> *mut u8 {
    let read = |p: *const u8, n: usize| String::from_utf8(std::slice::from_raw_parts(p, n).to_vec());
    let json = match (read(ep_ptr, ep_len), read(body_ptr, body_len)) {
        (Ok(ep), Ok(body)) => handle(&ep, &body),
        _ => serde_json::json!({ "status": 400, "body": "{\"ok\":false,\"error\":\"input is not UTF-8\"}" }).to_string(),
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

    #[test]
    fn answers_like_the_server() {
        let v: serde_json::Value = serde_json::from_str(&handle("/validate-address", r#"{"address":"tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx","network":"testnet"}"#)).unwrap();
        assert_eq!(v["status"], 200);
        assert_eq!(v["body"], r#"{"ok":true,"valid":true}"#);
        let bad: serde_json::Value = serde_json::from_str(&handle("/nope", "{}")).unwrap();
        assert_eq!(bad["status"], 404);
    }

    #[test]
    fn ffi_round_trip() {
        let (ep, body) = ("/validate-address", r#"{"address":"x","network":"marsnet"}"#);
        unsafe {
            let p = dt_handle(ep.as_ptr(), ep.len(), body.as_ptr(), body.len());
            let len = u32::from_le_bytes(std::slice::from_raw_parts(p, 4).try_into().unwrap()) as usize;
            let s = std::str::from_utf8(std::slice::from_raw_parts(p.add(4), len)).unwrap().to_string();
            dt_dealloc(p, 4 + len);
            let v: serde_json::Value = serde_json::from_str(&s).unwrap();
            assert_eq!(v["status"], 400);
            assert_eq!(v["body"], r#"{"ok":false,"error":"unknown network: marsnet"}"#);
        }
    }
}
