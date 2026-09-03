use rand::{RngCore, rngs::OsRng};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{
    AppHandle, Manager, Runtime, State, WebviewWindow,
    ipc::{Request, Response},
};

use super::backend::capture_frame_at_cursor_exclusive;
use super::contract::{
    CaptureError, CaptureErrorCode, CaptureResultDescriptor, CaptureTarget, CapturedFrame,
    MAX_PNG_RESULT_BYTES, NativeCapturePhase,
};
use super::export::{SaveCaptureOutcome, TauriCaptureExportPort, stable_png_filename};
use super::ipc::{raw_response, require_raw_body};
use super::platform::XcapBackend;
use super::runtime::{
    CapturePublishOutcome, CaptureStartResponse, CaptureTicket, CaptureTimeoutKind,
    OVERLAY_WINDOW_LABEL, OverlayInit, ScreenCaptureRuntime, acquire_and_publish_once,
};
use super::window::TauriCaptureWindowPort;

pub const RESULT_SESSION_HEADER: &str = "x-plain-capture-session-id";
pub const RESULT_GENERATION_HEADER: &str = "x-plain-capture-overlay-generation";
pub const RESULT_WIDTH_HEADER: &str = "x-plain-capture-width";
pub const RESULT_HEIGHT_HEADER: &str = "x-plain-capture-height";
const CAPTURE_READINESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CAPTURE_LIFETIME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const COMPOSITOR_UNMAP_SETTLE: Duration = Duration::from_millis(100);
const CAPTURE_BACKEND_TIMEOUT: Duration = Duration::from_secs(135);
#[cfg(target_os = "linux")]
const PORTAL_INTERACTION_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(target_os = "linux")]
const PORTAL_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

#[tauri::command]
pub fn screen_capture_register_target(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    target_token: String,
) -> Result<(), CaptureError> {
    runtime.register_eligible_target(window.label(), &target_token)
}

#[tauri::command]
pub fn screen_capture_unregister_target(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    target_token: String,
) -> Result<(), CaptureError> {
    runtime.unregister_eligible_target(window.label(), &target_token)
}

#[tauri::command]
pub async fn screen_capture_start(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    target_window_label: String,
    target_token: String,
) -> Result<CaptureStartResponse, CaptureError> {
    let app = window.app_handle().clone();
    let windows = TauriCaptureWindowPort::new(app.clone());
    let reservation = runtime.reserve_composer_capture(
        window.label(),
        new_capture_session_id(),
        CaptureTarget {
            window_label: target_window_label,
            target_token,
        },
        &windows,
    )?;
    let mut response = reservation.response;
    schedule_capture_timeouts(app.clone(), &response);
    if let Some(ticket) = reservation.ticket {
        finish_reserved_capture(app, &runtime, ticket).await?;
        response.phase = runtime.active_phase()?;
    }
    Ok(response)
}

#[tauri::command]
pub async fn screen_capture_ready(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    overlay_generation: u64,
    protocol_version: u32,
) -> Result<NativeCapturePhase, CaptureError> {
    let app = window.app_handle().clone();
    let windows = TauriCaptureWindowPort::new(app.clone());
    let (phase, ticket) = runtime.mark_overlay_ready(
        window.label(),
        overlay_generation,
        protocol_version,
        &windows,
    )?;
    if let Some(ticket) = ticket {
        finish_reserved_capture(app, &runtime, ticket).await?;
        runtime.active_phase()
    } else {
        Ok(phase)
    }
}

#[tauri::command]
pub fn screen_capture_take_frame(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    overlay_generation: u64,
) -> Result<Response, CaptureError> {
    runtime
        .take_frame(window.label(), &session_id, overlay_generation)
        .map(raw_response)
}

#[tauri::command]
pub fn screen_capture_frame_presented(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    overlay_generation: u64,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.frame_presented(window.label(), &session_id, overlay_generation, &windows)
}

#[tauri::command]
pub fn screen_capture_submit_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    request: Request<'_>,
) -> Result<CaptureResultDescriptor, CaptureError> {
    if window.label() != OVERLAY_WINDOW_LABEL {
        return Err(CaptureError::new(
            CaptureErrorCode::UnauthorizedCaller,
            "only the dedicated capture overlay may submit result pixels",
        ));
    }
    let session_id = required_header(&request, RESULT_SESSION_HEADER)?.to_string();
    let overlay_generation = parsed_header::<u64>(&request, RESULT_GENERATION_HEADER)?;
    let width = parsed_header::<u32>(&request, RESULT_WIDTH_HEADER)?;
    let height = parsed_header::<u32>(&request, RESULT_HEIGHT_HEADER)?;
    let bytes = require_raw_body(request.body())?;
    if bytes.len() > MAX_PNG_RESULT_BYTES {
        return Err(CaptureError::new(
            CaptureErrorCode::FrameTooLarge,
            "capture result exceeds the process memory limit",
        ));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            CaptureError::new(CaptureErrorCode::EncodeFailed, "system time is unavailable")
        })?
        .as_millis();
    runtime.store_result(
        window.label(),
        &session_id,
        overlay_generation,
        new_capture_result_id(),
        stable_png_filename(now),
        width,
        height,
        bytes.to_vec(),
    )
}

#[tauri::command]
pub fn screen_capture_send_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    overlay_generation: u64,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.publish_result(
        window.label(),
        &session_id,
        &result_id,
        overlay_generation,
        &windows,
    )
}

#[tauri::command]
pub fn screen_capture_take_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    target_token: String,
) -> Result<Response, CaptureError> {
    runtime
        .take_result(
            window.label(),
            &session_id,
            &result_id,
            &target_token,
            new_capture_delivery_lease_id(),
        )
        .map(raw_response)
}

#[tauri::command]
pub fn screen_capture_release_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    target_token: String,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.release_result(
        window.label(),
        &session_id,
        &result_id,
        &target_token,
        &windows,
    )
}

#[tauri::command]
pub fn screen_capture_ack_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    target_token: String,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.ack_result(
        window.label(),
        &session_id,
        &result_id,
        &target_token,
        &windows,
    )
}

#[tauri::command]
pub async fn screen_capture_save_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    overlay_generation: u64,
) -> Result<SaveCaptureOutcome, CaptureError> {
    let app = window.app_handle().clone();
    let windows = TauriCaptureWindowPort::new(app.clone());
    let exports = TauriCaptureExportPort::new(app);
    runtime.save_result(
        window.label(),
        &session_id,
        &result_id,
        overlay_generation,
        &exports,
        &windows,
    )
}

#[tauri::command]
pub fn screen_capture_copy_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    overlay_generation: u64,
) -> Result<(), CaptureError> {
    let app = window.app_handle().clone();
    let windows = TauriCaptureWindowPort::new(app.clone());
    let exports = TauriCaptureExportPort::new(app);
    runtime.copy_result(
        window.label(),
        &session_id,
        &result_id,
        overlay_generation,
        &exports,
        &windows,
    )
}

#[tauri::command]
pub fn screen_capture_discard_result(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    result_id: String,
    overlay_generation: u64,
) -> Result<NativeCapturePhase, CaptureError> {
    runtime.discard_result(window.label(), &session_id, &result_id, overlay_generation)
}

#[tauri::command]
pub fn screen_capture_invalidate_target(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    target_token: String,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.invalidate_target_from_window(window.label(), &session_id, &target_token, &windows)
}

#[tauri::command]
pub fn screen_capture_fail(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    overlay_generation: u64,
    code: String,
    detail: String,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.fail_from_overlay(
        window.label(),
        &session_id,
        overlay_generation,
        &code,
        &detail,
        &windows,
    )
}

#[tauri::command]
pub fn screen_capture_cancel(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    session_id: String,
    overlay_generation: Option<u64>,
) -> Result<(), CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.cancel_from_window(window.label(), &session_id, overlay_generation, &windows)
}

#[tauri::command]
pub fn screen_capture_unavailable(
    window: WebviewWindow,
    runtime: State<'_, ScreenCaptureRuntime>,
    overlay_generation: u64,
) -> Result<OverlayInit, CaptureError> {
    let windows = TauriCaptureWindowPort::new(window.app_handle().clone());
    runtime.overlay_unavailable(window.label(), overlay_generation, &windows)
}

/// Hook for the application's global `WindowEvent::Destroyed` branch. Related
/// origin/target destruction terminates the session. For the overlay, the delay
/// only covers rebuilding the fixed-label webview; session buffer cleanup and
/// origin restoration run synchronously before this function returns.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if label != OVERLAY_WINDOW_LABEL {
        let runtime = app.state::<ScreenCaptureRuntime>();
        let windows = TauriCaptureWindowPort::new(app.clone());
        if let Err(error) = runtime.prepare_window_close(label, &windows) {
            log::warn!("screen capture participant destruction cleanup failed: {error}");
        }
        return;
    }
    let runtime = app.state::<ScreenCaptureRuntime>();
    let windows = TauriCaptureWindowPort::new(app.clone());
    if let Err(error) = runtime.overlay_destroyed(&windows) {
        log::warn!("screen capture overlay destruction cleanup failed: {error}");
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(50));
        })
        .await;
        let runtime = app.state::<ScreenCaptureRuntime>();
        let windows = TauriCaptureWindowPort::new(app.clone());
        if let Err(error) = runtime.ensure_overlay_native(&windows) {
            log::warn!("screen capture overlay rebuild failed: {error}");
        }
    });
}

/// Hook for the application's global `WindowEvent::CloseRequested` branch.
/// Call this for every window before allowing it to close so a capture origin
/// is restored while both native windows still exist.
pub fn on_window_close_requested(app: &AppHandle, label: &str) {
    let runtime = app.state::<ScreenCaptureRuntime>();
    let windows = TauriCaptureWindowPort::new(app.clone());
    if let Err(error) = runtime.prepare_window_close(label, &windows) {
        log::warn!("screen capture window close cleanup failed: {error}");
    }
}

pub(crate) async fn finish_reserved_capture<R: Runtime>(
    app: AppHandle<R>,
    runtime: &ScreenCaptureRuntime,
    ticket: CaptureTicket,
) -> Result<CapturePublishOutcome, CaptureError> {
    let windows = TauriCaptureWindowPort::new(app.clone());
    let session_id = ticket.session_id().to_string();
    acquire_and_publish_once(
        runtime,
        ticket,
        &windows,
        COMPOSITOR_UNMAP_SETTLE,
        CAPTURE_BACKEND_TIMEOUT,
        move || acquire_native_frame(app, session_id),
    )
    .await
}

async fn acquire_native_frame<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<CapturedFrame, CaptureError> {
    #[cfg(target_os = "linux")]
    if super::platform::wayland_cursor_is_unavailable(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
    ) {
        let monitors = super::wayland::available_monitor_geometries(&app)?;
        let (monitor, native) = super::wayland::capture_monitor_via_portal(
            monitors,
            PORTAL_INTERACTION_TIMEOUT,
            PORTAL_FRAME_TIMEOUT,
        )
        .await?;
        return CapturedFrame::new(
            session_id,
            monitor,
            native.width,
            native.height,
            native.stride,
            native.bytes,
        );
    }

    tauri::async_runtime::spawn_blocking(move || {
        let backend = XcapBackend::new(app);
        capture_frame_at_cursor_exclusive(&backend, &session_id)
    })
    .await
    .map_err(|_| {
        CaptureError::new(
            CaptureErrorCode::CaptureFailed,
            "screen capture backend task failed",
        )
    })?
}

/// Session IDs are correlation handles, not caller-provided authority. Native
/// shortcut wiring should use this helper too.
pub(crate) fn new_capture_session_id() -> String {
    new_random_id("capture")
}

pub(crate) fn schedule_capture_timeouts<R: Runtime>(
    app: AppHandle<R>,
    response: &CaptureStartResponse,
) {
    schedule_capture_timeout(
        app.clone(),
        response,
        CaptureTimeoutKind::Readiness,
        CAPTURE_READINESS_TIMEOUT,
    );
    schedule_capture_timeout(
        app,
        response,
        CaptureTimeoutKind::Lifetime,
        CAPTURE_LIFETIME_TIMEOUT,
    );
}

fn schedule_capture_timeout<R: Runtime>(
    app: AppHandle<R>,
    response: &CaptureStartResponse,
    kind: CaptureTimeoutKind,
    delay: std::time::Duration,
) {
    let session_id = response.session_id.clone();
    let overlay_generation = response.overlay_generation;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let runtime = app.state::<ScreenCaptureRuntime>();
        let windows = TauriCaptureWindowPort::new(app.clone());
        if let Err(error) = runtime.expire_session(&session_id, overlay_generation, kind, &windows)
        {
            log::warn!("screen capture timeout cleanup failed: {error}");
        }
    });
}

fn new_capture_result_id() -> String {
    new_random_id("result")
}

fn new_capture_delivery_lease_id() -> String {
    new_random_id("lease")
}

fn new_random_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut encoded = String::with_capacity(prefix.len() + 1 + bytes.len() * 2);
    encoded.push_str(prefix);
    encoded.push('-');
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to String is infallible");
    }
    encoded
}

fn required_header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, CaptureError> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CaptureError::new(
                CaptureErrorCode::InvalidFrame,
                format!("capture result request is missing required header {name}"),
            )
        })
}

fn parsed_header<T>(request: &Request<'_>, name: &str) -> Result<T, CaptureError>
where
    T: std::str::FromStr,
{
    required_header(request, name)?.parse().map_err(|_| {
        CaptureError::new(
            CaptureErrorCode::InvalidFrame,
            format!("capture result header {name} is invalid"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{new_capture_delivery_lease_id, new_capture_result_id, new_capture_session_id};

    #[test]
    fn native_session_ids_are_nonempty_and_not_reused() {
        let first = new_capture_session_id();
        let second = new_capture_session_id();
        assert!(first.starts_with("capture-"));
        assert_eq!(first.len(), "capture-".len() + 32);
        assert_ne!(first, second);
    }

    #[test]
    fn result_and_lease_authority_are_native_generated_and_namespaced() {
        let result = new_capture_result_id();
        let lease = new_capture_delivery_lease_id();
        assert!(result.starts_with("result-"));
        assert!(lease.starts_with("lease-"));
        assert_ne!(result, lease);
    }
}
