#[cfg(target_os = "windows")]
use once_cell::sync::OnceCell;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
  VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
  CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, MSG, SetWindowsHookExW,
  TranslateMessage, UnhookWindowsHookEx, HHOOK, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

#[cfg(target_os = "windows")]
static APP_HANDLE: OnceCell<tauri::AppHandle> = OnceCell::new();

#[cfg(target_os = "windows")]
#[derive(Clone, serde::Serialize)]
struct MediaKeyPayload {
  action: &'static str,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
  if code >= 0 {
    let msg = wparam.0 as u32;
    if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
      let kb = *(lparam.0 as *const KBDLLHOOKSTRUCT);
      let key = VIRTUAL_KEY(kb.vkCode as u16);
      let action = match key {
        VK_MEDIA_PLAY_PAUSE => Some("play_pause"),
        VK_MEDIA_NEXT_TRACK => Some("next"),
        VK_MEDIA_PREV_TRACK => Some("previous"),
        VK_MEDIA_STOP => Some("stop"),
        _ => None,
      };

      if let Some(action) = action {
        if let Some(app) = APP_HANDLE.get() {
          let _ = app.emit_all("media-key", MediaKeyPayload { action });
        }
      }
    }
  }

  CallNextHookEx(HHOOK(std::ptr::null_mut()), code, wparam, lparam)
}

#[cfg(target_os = "windows")]
pub fn init(app: &tauri::AppHandle) {
  let _ = APP_HANDLE.set(app.clone());

  std::thread::spawn(|| unsafe {
    let hook = match SetWindowsHookExW(
      WH_KEYBOARD_LL,
      Some(keyboard_hook),
      HINSTANCE(std::ptr::null_mut()),
      0,
    ) {
      Ok(value) => value,
      Err(err) => {
        eprintln!("media keys hook failed: {err:?}");
        return;
      }
    };
    if hook.0 == std::ptr::null_mut() {
      let err = GetLastError();
      eprintln!("media keys hook failed: {err:?}");
      return;
    }

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).into() {
      let _ = TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }

    let _ = UnhookWindowsHookEx(hook);
  });
}

#[cfg(not(target_os = "windows"))]
pub fn init(_app: &tauri::AppHandle) {}
