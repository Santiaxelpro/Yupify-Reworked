use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[no_mangle]
pub extern "C" fn echo(input: *const c_char) -> *mut c_char {
    if input.is_null() {
        return CString::new("null").unwrap().into_raw();
    }
    let cstr = unsafe { CStr::from_ptr(input) };
    let s = cstr.to_string_lossy();
    let resp = format!("Echo desde Rust: {}", s);
    CString::new(resp).unwrap().into_raw()
}

#[no_mangle]
pub extern "C" fn free_rust_string(s: *mut c_char) {
    if s.is_null() { return; }
    unsafe { CString::from_raw(s); }
}
