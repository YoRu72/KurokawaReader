//! kt-android: Kurokawa Tools' Android library (docs/RUST-PORT.md §5, stages M0–M6). kt-core's rules called from
//! Java through ONE native method (src/jni.rs — the only unsafe code) and a table of named methods (src/dispatch.rs);
//! each later stage adds methods to that table, never a JNI signature. Java's side is
//! apps/tools/native/android/KtCore.java; how it all fits: ANDROID-PORT.md beside this file.

mod jni;
pub mod dispatch;
// (Stage M2: the downloader's `http.*` methods and `bytes.megaCtr`.)
mod httpcall;
// (Stage M5: the file jobs' `fj.*`, archives' `ar.*`, the vault's `vt.*`, network storages' `rm.*`.)
mod m5call;

/// The answer as Java reads it: one status byte (0 ok, 1 error), then the payload (the method's answer, or a UTF-8
/// error message).
pub fn frame(r: Result<Vec<u8>, String>) -> Vec<u8> {
    match r {
        Ok(mut b) => {
            b.insert(0, 0u8);
            b
        }
        Err(e) => {
            let mut b = Vec::with_capacity(e.len() + 1);
            b.push(1u8);
            b.extend_from_slice(e.as_bytes());
            b
        }
    }
}

/// What a caught panic said, for the error answer.
pub fn panic_text(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        format!("panic: {}", s)
    } else if let Some(s) = p.downcast_ref::<String>() {
        format!("panic: {}", s)
    } else {
        "panic".to_string()
    }
}
