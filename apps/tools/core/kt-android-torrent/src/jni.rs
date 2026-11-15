//! The whole JNI surface, and the only `unsafe` in the crate: one native method, written by hand against the JNI
//! function table (no `jni` crate), and `JNI_OnLoad`.
//!
//! Java (apps/tools/native/android/KtTorrentCore.java):
//!     private static native byte[] nCall(byte[] method, byte[] args, byte[] data);
//! → symbol `Java_app_kurokawa_tools_KtTorrentCore_nCall`, signature `([B[B[B)[B`, static (so the second argument is the
//! class). Every later stage adds Rust functions behind `dispatch::call`, never another JNI signature.
//!
//! Only byte arrays cross: Java turns strings into UTF-8 itself, so none of JNI's «modified UTF-8» string functions
//! is used (on a debuggable Android build CheckJNI aborts the app on a 4-byte UTF-8 sequence given to NewStringUTF).
//! Five table entries are used; their indices are the JNI specification's (the same on every VM — checked against
//! the JDK's jni.h, see ANDROID-PORT.md):
//!   17 ExceptionClear · 171 GetArrayLength · 176 NewByteArray · 200 GetByteArrayRegion · 208 SetByteArrayRegion ·
//!   228 ExceptionCheck
//!
//! Panics: everything that can panic runs inside `catch_unwind` (the release profile keeps panic = "unwind"); a panic
//! comes back to Java as an error answer, never unwinds into the VM.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};

type JObject = *mut c_void; // jobject / jclass / jbyteArray: opaque references
type JSize = i32; // jsize = jint
type JBoolean = u8; // jboolean = unsigned char
type JByte = i8; // jbyte = signed char
/// JNIEnv*: a pointer to a pointer to the function table (an array of function pointers).
type Env = *mut *const *const c_void;

const EXCEPTION_CLEAR: usize = 17;
const GET_ARRAY_LENGTH: usize = 171;
const NEW_BYTE_ARRAY: usize = 176;
const GET_BYTE_ARRAY_REGION: usize = 200;
const SET_BYTE_ARRAY_REGION: usize = 208;
const EXCEPTION_CHECK: usize = 228;
const JNI_VERSION_1_6: i32 = 0x0001_0006;

/// The table entry `i` (a function pointer, as an untyped pointer).
unsafe fn entry(env: Env, i: usize) -> *const c_void {
    *(*env).add(i)
}

unsafe fn exception_check(env: Env) -> bool {
    let f: extern "system" fn(Env) -> JBoolean = std::mem::transmute(entry(env, EXCEPTION_CHECK));
    f(env) != 0
}

unsafe fn exception_clear(env: Env) {
    let f: extern "system" fn(Env) = std::mem::transmute(entry(env, EXCEPTION_CLEAR));
    f(env)
}

/// A Java byte[] copied out (null → empty). None: the VM raised an exception (left pending for Java to see).
unsafe fn read_bytes(env: Env, arr: JObject) -> Option<Vec<u8>> {
    if arr.is_null() {
        return Some(Vec::new());
    }
    let len_f: extern "system" fn(Env, JObject) -> JSize = std::mem::transmute(entry(env, GET_ARRAY_LENGTH));
    let n = len_f(env, arr);
    if n <= 0 {
        return Some(Vec::new());
    }
    let mut buf = vec![0u8; n as usize];
    let get_f: extern "system" fn(Env, JObject, JSize, JSize, *mut JByte) = std::mem::transmute(entry(env, GET_BYTE_ARRAY_REGION));
    get_f(env, arr, 0, n, buf.as_mut_ptr() as *mut JByte);
    if exception_check(env) {
        return None;
    }
    Some(buf)
}

/// A new Java byte[] holding `b` (null if the VM could not make it — an OutOfMemoryError is then pending).
unsafe fn new_bytes(env: Env, b: &[u8]) -> JObject {
    if b.len() > i32::MAX as usize {
        return std::ptr::null_mut();
    }
    let new_f: extern "system" fn(Env, JSize) -> JObject = std::mem::transmute(entry(env, NEW_BYTE_ARRAY));
    let arr = new_f(env, b.len() as JSize);
    if arr.is_null() {
        return arr;
    }
    if !b.is_empty() {
        let set_f: extern "system" fn(Env, JObject, JSize, JSize, *const JByte) = std::mem::transmute(entry(env, SET_BYTE_ARRAY_REGION));
        set_f(env, arr, 0, b.len() as JSize, b.as_ptr() as *const JByte);
        if exception_check(env) {
            return std::ptr::null_mut();
        }
    }
    arr
}

/// The library's only Java method. The answer is `[status] + payload` (crate::frame): 0 = ok, then the method's
/// answer (JSON text, or bytes for a bytes method); 1 = error, then a UTF-8 message. null only when the VM could not
/// allocate the answer (an exception then pending, which Java catches).
#[no_mangle]
pub extern "system" fn Java_app_kurokawa_tools_KtTorrentCore_nCall(env: Env, _class: JObject, method: JObject, args: JObject, data: JObject) -> JObject {
    if env.is_null() {
        return std::ptr::null_mut();
    }
    // (Reading the arrays cannot panic; the dispatch can, and is caught.)
    let input = unsafe { (read_bytes(env, method), read_bytes(env, args), read_bytes(env, data)) };
    let (m, a, d) = match input {
        (Some(m), Some(a), Some(d)) => (m, a, d),
        _ => return std::ptr::null_mut(), // (the VM's exception goes up to Java)
    };
    let answer = match catch_unwind(AssertUnwindSafe(|| crate::dispatch::call_bytes(&m, &a, &d))) {
        Ok(r) => crate::frame(r),
        Err(p) => crate::frame(Err(crate::panic_text(&p))),
    };
    unsafe {
        let out = new_bytes(env, &answer);
        if out.is_null() && exception_check(env) {
            // (Out of memory for the answer: cleared and retried once with a short error, so Java gets an answer.)
            exception_clear(env);
            return new_bytes(env, &crate::frame(Err("out of memory".to_string())));
        }
        out
    }
}

/// Tells the VM which JNI version the library needs (1.6: every Android, every JDK).
#[no_mangle]
pub extern "system" fn JNI_OnLoad(_vm: *mut c_void, _reserved: *mut c_void) -> i32 {
    JNI_VERSION_1_6
}
