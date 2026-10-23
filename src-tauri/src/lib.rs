use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex, atomic::AtomicBool},
    thread,
    time::{Duration, Instant},
};
use tauri::window::Monitor;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(windows)]
use windows::Win32::{
    Foundation::POINT,
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
        Shell::{
            QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME, QUNS_RUNNING_D3D_FULL_SCREEN,
            SHQueryUserNotificationState,
        },
        WindowsAndMessaging::GetCursorPos,
    },
};

#[derive(Clone, Deserialize)]
#[serde(tag = "shape", rename_all = "camelCase")]
enum HitRegion {
    Circle {
        cx: f64,
        cy: f64,
        radius: f64,
    },
    Rect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

impl HitRegion {
    fn contains(&self, x: f64, y: f64) -> bool {
        match self {
            Self::Circle { cx, cy, radius } => {
                let dx = x - cx;
                let dy = y - cy;
                dx * dx + dy * dy <= radius * radius
            }
            Self::Rect {
                x: left,
                y: top,
                width,
                height,
            } => x >= *left && y >= *top && x <= *left + *width && y <= *top + *height,
        }
    }
}

#[derive(Clone, Default)]
struct HitRegions(Arc<Mutex<Vec<HitRegion>>>);

#[derive(Clone, Default)]
struct DragTracker(Arc<Mutex<Option<DragState>>>);

struct DragState {
    cursor_start: PhysicalPosition<i32>,
    window_start: PhysicalPosition<i32>,
    moved: bool,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct PositionData {
    positions: HashMap<String, SavedPosition>,
    last_monitor: Option<String>,
}

#[derive(Clone)]
struct PositionStore {
    path: PathBuf,
    data: Arc<Mutex<PositionData>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct RuntimeSettings {
    global_hotkey: String,
    pause_animations: bool,
    do_not_disturb: bool,
    current_mode: usize,
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            global_hotkey: "Ctrl+Shift+Alt+A".to_string(),
            pause_animations: false,
            do_not_disturb: false,
            current_mode: 0,
        }
    }
}

#[derive(Clone)]
struct SettingsStore {
    path: PathBuf,
    data: Arc<Mutex<RuntimeSettings>>,
}

#[derive(Clone)]
struct UiHeartbeat(Arc<Mutex<Instant>>);

#[derive(Clone, Default)]
struct NativeQuietState(Arc<AtomicBool>);

#[tauri::command]
fn set_hit_regions(
    regions: Vec<HitRegion>,
    state: tauri::State<'_, HitRegions>,
) -> Result<(), String> {
    let mut current = state
        .0
        .lock()
        .map_err(|_| "Hit-region state is unavailable".to_string())?;
    *current = regions;
    Ok(())
}

#[tauri::command]
fn get_runtime_settings(
    settings: tauri::State<'_, SettingsStore>,
) -> Result<RuntimeSettings, String> {
    settings
        .data
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "Runtime settings are unavailable".to_string())
}

#[tauri::command]
fn watchdog_ping(heartbeat: tauri::State<'_, UiHeartbeat>) -> Result<(), String> {
    let mut last_ping = heartbeat
        .0
        .lock()
        .map_err(|_| "UI watchdog state is unavailable".to_string())?;
    *last_ping = Instant::now();
    Ok(())
}

#[tauri::command]
fn get_focus_assist_state(
    settings: tauri::State<'_, SettingsStore>,
    native_quiet: tauri::State<'_, NativeQuietState>,
) -> Result<bool, String> {
    let manual_quiet = settings
        .data
        .lock()
        .map(|settings| settings.do_not_disturb)
        .map_err(|_| "Runtime settings are unavailable".to_string())?;
    let os_quiet = os_quiet_mode_is_active()?;
    native_quiet
        .0
        .store(os_quiet, std::sync::atomic::Ordering::Relaxed);
    Ok(manual_quiet || os_quiet)
}

#[tauri::command]
fn get_fullscreen_state() -> Result<bool, String> {
    fullscreen_app_is_active()
}

#[tauri::command]
fn set_global_hotkey(
    app: AppHandle,
    hotkey: String,
    settings: tauri::State<'_, SettingsStore>,
) -> Result<String, String> {
    if !hotkey.contains('+') {
        return Err("Use a key plus at least one modifier, such as Ctrl+Shift+Alt+A".into());
    }
    let parsed =
        Shortcut::from_str(&hotkey).map_err(|error| format!("Invalid global shortcut: {error}"))?;
    let canonical = parsed.to_string();
    if canonical.eq_ignore_ascii_case("control+alt+arrowleft")
        || canonical.eq_ignore_ascii_case("control+alt+arrowright")
    {
        return Err("That shortcut is reserved for changing modes".into());
    }
    let previous = settings
        .data
        .lock()
        .map_err(|_| "Runtime settings are unavailable".to_string())?
        .clone();
    if canonical.eq_ignore_ascii_case(&previous.global_hotkey) {
        return Ok(canonical);
    }

    app.global_shortcut()
        .register(canonical.as_str())
        .map_err(|error| format!("Could not register shortcut {canonical}: {error}"))?;

    if let Err(error) = app
        .global_shortcut()
        .unregister(previous.global_hotkey.as_str())
    {
        return match app.global_shortcut().unregister(canonical.as_str()) {
            Ok(()) => Err(format!(
                "Could not replace shortcut {}: {error}",
                previous.global_hotkey
            )),
            Err(cleanup_error) => Err(format!(
                "Could not replace shortcut {}: {error}; could not remove the new shortcut: {cleanup_error}",
                previous.global_hotkey
            )),
        };
    }

    let mut updated = previous.clone();
    updated.global_hotkey = canonical.clone();
    if let Err(error) = write_settings(&settings.path, &updated) {
        let restore_result = app
            .global_shortcut()
            .register(previous.global_hotkey.as_str());
        let cleanup_result = app.global_shortcut().unregister(canonical.as_str());
        return match (restore_result, cleanup_result) {
            (Ok(()), Ok(())) => Err(format!("Could not save shortcut settings: {error}")),
            (Err(restore_error), Ok(())) => Err(format!(
                "Could not save shortcut settings: {error}; could not restore the previous shortcut: {restore_error}"
            )),
            (Ok(()), Err(cleanup_error)) => Err(format!(
                "Could not save shortcut settings: {error}; previous shortcut restored, but could not remove the new shortcut: {cleanup_error}"
            )),
            (Err(restore_error), Err(cleanup_error)) => Err(format!(
                "Could not save shortcut settings: {error}; could not restore the previous shortcut: {restore_error}; could not remove the new shortcut: {cleanup_error}"
            )),
        };
    }

    *settings
        .data
        .lock()
        .map_err(|_| "Runtime settings are unavailable".to_string())? = updated;
    Ok(canonical)
}

#[tauri::command]
fn set_pause_animations(
    paused: bool,
    app: AppHandle,
    settings: tauri::State<'_, SettingsStore>,
) -> Result<(), String> {
    let updated = {
        let current = settings
            .data
            .lock()
            .map_err(|_| "Runtime settings are unavailable".to_string())?;
        let mut updated = current.clone();
        updated.pause_animations = paused;
        updated
    };
    write_settings(&settings.path, &updated)?;
    *settings
        .data
        .lock()
        .map_err(|_| "Runtime settings are unavailable".to_string())? = updated;
    app.emit("pause-animations", paused)
        .map_err(|error| format!("Could not publish animation state: {error}"))
}

#[tauri::command]
fn save_current_mode(mode: usize, settings: tauri::State<'_, SettingsStore>) -> Result<(), String> {
    if mode >= 6 {
        return Err("Mode index must be between 0 and 5".into());
    }
    let updated = {
        let current = settings
            .data
            .lock()
            .map_err(|_| "Runtime settings are unavailable".to_string())?;
        let mut updated = current.clone();
        updated.current_mode = mode;
        updated
    };
    write_settings(&settings.path, &updated)?;
    *settings
        .data
        .lock()
        .map_err(|_| "Runtime settings are unavailable".to_string())? = updated;
    Ok(())
}

fn write_settings(path: &PathBuf, settings: &RuntimeSettings) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Could not encode runtime settings: {error}"))?;
    fs::write(path, content).map_err(|error| format!("Could not save runtime settings: {error}"))
}

#[tauri::command]
fn begin_disk_drag(
    window: WebviewWindow,
    tracker: tauri::State<'_, DragTracker>,
) -> Result<(), String> {
    let cursor = cursor_position()?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Could not read widget position: {error}"))?;
    let mut state = tracker
        .0
        .lock()
        .map_err(|_| "Drag state is unavailable".to_string())?;
    *state = Some(DragState {
        cursor_start: cursor,
        window_start: position,
        moved: false,
    });
    Ok(())
}

#[tauri::command]
fn toggle_widget(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    let is_visible = window
        .is_visible()
        .map_err(|error| format!("Could not read widget visibility: {error}"))?;
    if is_visible {
        window
            .hide()
            .map_err(|error| format!("Could not hide widget: {error}"))?;
    } else {
        window
            .show()
            .map_err(|error| format!("Could not show widget: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Could not focus widget: {error}"))?;
    }
    window
        .emit("widget-visibility", !is_visible)
        .map_err(|error| format!("Could not publish widget visibility: {error}"))
}

fn reset_position(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    window
        .center()
        .map_err(|error| format!("Could not center widget: {error}"))?;
    let positions = app.state::<PositionStore>();
    persist_position(&window, positions.inner())
}

fn set_do_not_disturb(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let settings = app.state::<SettingsStore>();
    let updated = {
        let current = settings
            .data
            .lock()
            .map_err(|_| "Runtime settings are unavailable".to_string())?;
        let mut updated = current.clone();
        updated.do_not_disturb = enabled;
        updated
    };
    write_settings(&settings.path, &updated)?;
    *settings
        .data
        .lock()
        .map_err(|_| "Runtime settings are unavailable".to_string())? = updated;
    let native_quiet = os_quiet_mode_is_active()?;
    app.state::<NativeQuietState>()
        .0
        .store(native_quiet, std::sync::atomic::Ordering::Relaxed);
    app.emit("focus-assist-state", enabled || native_quiet)
        .map_err(|error| format!("Could not publish notification state: {error}"))
}

#[tauri::command]
fn cycle_mode(direction: i32, app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    if window
        .is_visible()
        .map_err(|error| format!("Could not read widget visibility: {error}"))?
    {
        app.emit("cycle-mode", direction)
            .map_err(|error| format!("Could not switch mode: {error}"))?;
    }
    Ok(())
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "The Disk window is not available".to_string())
}

fn monitor_key(window: &WebviewWindow) -> Result<String, String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Could not identify the current monitor: {error}"))?;
    Ok(monitor
        .and_then(|monitor| monitor.name().cloned())
        .unwrap_or_else(|| "default".to_string()))
}

fn clamp_to_monitor(
    position: SavedPosition,
    window_size: PhysicalSize<u32>,
    monitor: &Monitor,
) -> SavedPosition {
    let origin = monitor.position();
    let size = monitor.size();
    let max_x = origin.x + size.width as i32 - window_size.width as i32;
    let max_y = origin.y + size.height as i32 - window_size.height as i32;
    SavedPosition {
        x: position.x.clamp(origin.x, max_x.max(origin.x)),
        y: position.y.clamp(origin.y, max_y.max(origin.y)),
    }
}

fn restore_position(window: &WebviewWindow, store: &PositionStore) -> Result<(), String> {
    let current_key = monitor_key(window)?;
    let (key, saved) = {
        let data = store
            .data
            .lock()
            .map_err(|_| "Position store is unavailable".to_string())?;
        let key = data.last_monitor.clone().unwrap_or(current_key);
        let saved = data.positions.get(&key).copied();
        (key, saved)
    };
    let Some(saved) = saved else {
        return Ok(());
    };
    let size = window
        .inner_size()
        .map_err(|error| format!("Could not read widget size: {error}"))?;
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Could not enumerate monitors: {error}"))?;
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.name().map(String::as_str) == Some(key.as_str()))
        .or_else(|| monitors.first());
    let position = monitor
        .map(|monitor| clamp_to_monitor(saved, size, monitor))
        .unwrap_or(saved);
    window
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|error| format!("Could not restore widget position: {error}"))
}

fn persist_position(window: &WebviewWindow, store: &PositionStore) -> Result<(), String> {
    let key = monitor_key(window)?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Could not read widget position: {error}"))?;
    let mut data = store
        .data
        .lock()
        .map_err(|_| "Position store is unavailable".to_string())?;
    data.positions.insert(
        key.clone(),
        SavedPosition {
            x: position.x,
            y: position.y,
        },
    );
    data.last_monitor = Some(key);
    let content = serde_json::to_vec_pretty(&*data)
        .map_err(|error| format!("Could not encode position data: {error}"))?;
    fs::write(&store.path, content)
        .map_err(|error| format!("Could not save widget position: {error}"))
}

fn clamp_window_to_monitor(window: &WebviewWindow) -> Result<(), String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("Could not read widget position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Could not read widget size: {error}"))?;
    let monitor = window
        .current_monitor()
        .map_err(|error| format!("Could not identify the current monitor: {error}"))?
        .or(window
            .primary_monitor()
            .map_err(|error| format!("Could not identify the primary monitor: {error}"))?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let clamped = clamp_to_monitor(
        SavedPosition {
            x: position.x,
            y: position.y,
        },
        size,
        &monitor,
    );
    if position.x != clamped.x || position.y != clamped.y {
        window
            .set_position(PhysicalPosition::new(clamped.x, clamped.y))
            .map_err(|error| format!("Could not clamp widget to monitor: {error}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn cursor_position() -> Result<PhysicalPosition<i32>, String> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }
        .map_err(|error| format!("Could not read cursor position: {error}"))?;
    Ok(PhysicalPosition::new(point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_position() -> Result<PhysicalPosition<i32>, String> {
    Err("Disk's cursor tracking is supported on Windows only".to_string())
}

#[cfg(windows)]
fn left_button_is_down() -> bool {
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

#[cfg(not(windows))]
fn left_button_is_down() -> bool {
    false
}

#[cfg(windows)]
fn fullscreen_app_is_active() -> Result<bool, String> {
    unsafe { SHQueryUserNotificationState() }
        .map(|state| state == QUNS_RUNNING_D3D_FULL_SCREEN)
        .map_err(|error| format!("Fullscreen detection failed: {error}"))
}

#[cfg(windows)]
fn os_quiet_mode_is_active() -> Result<bool, String> {
    unsafe { SHQueryUserNotificationState() }
        .map(|state| state == QUNS_QUIET_TIME || state == QUNS_PRESENTATION_MODE)
        .map_err(|error| format!("Could not query Windows notification state: {error}"))
}

#[cfg(not(windows))]
fn fullscreen_app_is_active() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
fn os_quiet_mode_is_active() -> Result<bool, String> {
    Ok(false)
}

fn start_native_loops(
    window: WebviewWindow,
    regions: tauri::State<'_, HitRegions>,
    tracker: tauri::State<'_, DragTracker>,
    positions: tauri::State<'_, PositionStore>,
    settings: tauri::State<'_, SettingsStore>,
    heartbeat: tauri::State<'_, UiHeartbeat>,
    native_quiet: tauri::State<'_, NativeQuietState>,
) {
    let regions = regions.inner().clone();
    let tracker = tracker.inner().clone();
    let positions = positions.inner().clone();
    let settings = settings.inner().clone();
    let heartbeat = heartbeat.inner().clone();
    let native_quiet = native_quiet.inner().clone();

    thread::spawn(move || {
        let mut last_ignore = None;
        let mut last_fullscreen = None;
        let mut last_pointer_target = None;
        let mut last_quiet_state = None;
        let mut last_activity_check = Instant::now() - Duration::from_secs(1);
        let mut last_watchdog_check = Instant::now();
        let mut last_watchdog_reload = Instant::now() - Duration::from_secs(60);
        let mut fullscreen = false;

        loop {
            if last_activity_check.elapsed() >= Duration::from_secs(1) {
                last_activity_check = Instant::now();
                match fullscreen_app_is_active() {
                    Ok(active) => {
                        if last_fullscreen != Some(active) {
                            last_fullscreen = Some(active);
                            fullscreen = active;
                            if let Err(error) = window.emit("fullscreen-state", active) {
                                eprintln!("Disk: could not publish fullscreen state: {error}");
                            }
                        } else {
                            fullscreen = active;
                        }
                    }
                    Err(error) => eprintln!("Disk: {error}"),
                }

                match os_quiet_mode_is_active() {
                    Ok(active) => {
                        native_quiet
                            .0
                            .store(active, std::sync::atomic::Ordering::Relaxed);
                        let manual_quiet = match settings.data.lock() {
                            Ok(settings) => settings.do_not_disturb,
                            Err(_) => {
                                eprintln!("Disk: runtime settings are unavailable");
                                continue;
                            }
                        };
                        let effective_quiet = active || manual_quiet;
                        if last_quiet_state != Some(effective_quiet) {
                            last_quiet_state = Some(effective_quiet);
                            if let Err(error) = window.emit("focus-assist-state", effective_quiet) {
                                eprintln!("Disk: could not publish notification state: {error}");
                            }
                        }
                    }
                    Err(error) => eprintln!("Disk: {error}"),
                }
            }

            if last_watchdog_check.elapsed() >= Duration::from_secs(5) {
                last_watchdog_check = Instant::now();
                let visible = match window.is_visible() {
                    Ok(visible) => visible,
                    Err(error) => {
                        eprintln!("Disk: could not read window visibility: {error}");
                        false
                    }
                };
                let stale = match heartbeat.0.lock() {
                    Ok(last_ping) => last_ping.elapsed() >= Duration::from_secs(20),
                    Err(_) => {
                        eprintln!("Disk: UI watchdog state is unavailable");
                        false
                    }
                };
                if visible && stale && last_watchdog_reload.elapsed() >= Duration::from_secs(30) {
                    eprintln!("Disk: UI heartbeat expired; reloading the widget");
                    last_watchdog_reload = Instant::now();
                    if let Err(error) = window.reload() {
                        eprintln!("Disk: could not recover the widget UI: {error}");
                    } else {
                        match heartbeat.0.lock() {
                            Ok(mut last_ping) => *last_ping = Instant::now(),
                            Err(_) => eprintln!("Disk: UI watchdog state is unavailable"),
                        }
                    }
                }
            }

            let visible = match window.is_visible() {
                Ok(visible) => visible,
                Err(error) => {
                    eprintln!("Disk: could not read window visibility: {error}");
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };
            if !visible {
                if last_pointer_target != Some(false) {
                    last_pointer_target = Some(false);
                    if let Err(error) = window.emit("pointer-target-state", false) {
                        eprintln!("Disk: could not publish pointer target state: {error}");
                    }
                }
                thread::sleep(Duration::from_millis(200));
                continue;
            }

            let cursor = match cursor_position() {
                Ok(cursor) => cursor,
                Err(error) => {
                    eprintln!("Disk: {error}");
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };
            let position = match window.outer_position() {
                Ok(position) => position,
                Err(error) => {
                    eprintln!("Disk: could not read window position: {error}");
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };
            let size = match window.inner_size() {
                Ok(size) => size,
                Err(error) => {
                    eprintln!("Disk: could not read window size: {error}");
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };
            let scale = match window.scale_factor() {
                Ok(scale) => scale,
                Err(error) => {
                    eprintln!("Disk: could not read window scale: {error}");
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };

            let dx = cursor.x - position.x;
            let dy = cursor.y - position.y;
            let inside_window =
                dx >= 0 && dy >= 0 && dx < size.width as i32 && dy < size.height as i32;
            let logical_x = dx as f64 / scale;
            let logical_y = dy as f64 / scale;
            let hit = match regions.0.lock() {
                Ok(regions) => regions
                    .iter()
                    .any(|region| inside_window && region.contains(logical_x, logical_y)),
                Err(_) => {
                    eprintln!("Disk: hit-region state is unavailable");
                    false
                }
            };

            if last_pointer_target != Some(hit) {
                last_pointer_target = Some(hit);
                if let Err(error) = window.emit("pointer-target-state", hit) {
                    eprintln!("Disk: could not publish pointer target state: {error}");
                }
            }

            let should_ignore = !hit || fullscreen;
            if last_ignore != Some(should_ignore) {
                if let Err(error) = window.set_ignore_cursor_events(should_ignore) {
                    eprintln!("Disk: could not update click-through state: {error}");
                } else {
                    last_ignore = Some(should_ignore);
                }
            }

            let mut drag_active = false;
            match tracker.0.lock() {
                Ok(mut drag_slot) => {
                    if let Some(drag) = drag_slot.as_mut() {
                        if !left_button_is_down() {
                            let should_save = drag.moved;
                            *drag_slot = None;
                            if should_save {
                                if let Err(error) = clamp_window_to_monitor(&window) {
                                    eprintln!("Disk: {error}");
                                } else if let Err(error) = persist_position(&window, &positions) {
                                    eprintln!("Disk: {error}");
                                }
                            }
                        } else {
                            drag_active = true;
                            let moved_x = cursor.x - drag.cursor_start.x;
                            let moved_y = cursor.y - drag.cursor_start.y;
                            if !drag.moved && (moved_x.abs() > 4 || moved_y.abs() > 4) {
                                drag.moved = true;
                            }
                            if drag.moved {
                                let next = PhysicalPosition::new(
                                    drag.window_start.x + moved_x,
                                    drag.window_start.y + moved_y,
                                );
                                if let Err(error) = window.set_position(next) {
                                    eprintln!("Disk: could not move widget: {error}");
                                }
                            }
                        }
                    }
                }
                Err(_) => eprintln!("Disk: drag state is unavailable"),
            }

            thread::sleep(if fullscreen {
                Duration::from_secs(1)
            } else if inside_window || drag_active {
                Duration::from_millis(33)
            } else {
                Duration::from_millis(200)
            });
        }
    });
}

fn open_settings(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window
            .show()
            .map_err(|error| format!("Could not show settings: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Could not focus settings: {error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Disk Settings")
        .inner_size(660.0, 480.0)
        .resizable(true)
        .build()
        .map(|_| ())
        .map_err(|error| format!("Could not open settings: {error}"))
}

fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItem::with_id(
        app,
        "show-hide",
        "Show / Hide Assistant",
        true,
        None::<&str>,
    )?;
    let reset_position_item = MenuItem::with_id(
        app,
        "reset-position",
        "Reset Position to Center",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let runtime = app.state::<SettingsStore>();
    let current_settings = runtime
        .data
        .lock()
        .map_err(|_| "Runtime settings are unavailable")?
        .clone();
    let do_not_disturb = CheckMenuItem::with_id(
        app,
        "do-not-disturb",
        "Do Not Disturb",
        true,
        current_settings.do_not_disturb,
        None::<&str>,
    )?;
    let pause_animations = CheckMenuItem::with_id(
        app,
        "pause-animations",
        "Pause Animations",
        true,
        current_settings.pause_animations,
        None::<&str>,
    )?;
    let startup_enabled = app.autolaunch().is_enabled()?;
    let start_with_windows = CheckMenuItem::with_id(
        app,
        "start-with-windows",
        "Start with Windows",
        true,
        startup_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &reset_position_item,
            &settings,
            &do_not_disturb,
            &pause_animations,
            &start_with_windows,
            &quit,
        ],
    )?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Missing tray icon"))?;
    let dnd_item = do_not_disturb.clone();
    let pause_item = pause_animations.clone();
    let startup_item = start_with_windows.clone();

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Disk")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show-hide" => {
                if let Err(error) = toggle_widget(app.clone()) {
                    eprintln!("Disk: {error}");
                }
            }
            "reset-position" => {
                if let Err(error) = reset_position(app) {
                    eprintln!("Disk: {error}");
                }
            }
            "settings" => {
                if let Err(error) = open_settings(app) {
                    eprintln!("Disk: {error}");
                }
            }
            "do-not-disturb" => {
                let settings = app.state::<SettingsStore>();
                let checked = match settings.data.lock() {
                    Ok(settings) => !settings.do_not_disturb,
                    Err(_) => {
                        eprintln!("Disk: runtime settings are unavailable");
                        return;
                    }
                };
                if let Err(error) = dnd_item.set_checked(checked) {
                    eprintln!("Disk: could not update Do Not Disturb menu: {error}");
                }
                if let Err(error) = set_do_not_disturb(app, checked) {
                    eprintln!("Disk: {error}");
                }
            }
            "pause-animations" => {
                let settings = app.state::<SettingsStore>();
                let paused = match settings.data.lock() {
                    Ok(settings) => !settings.pause_animations,
                    Err(_) => {
                        eprintln!("Disk: runtime settings are unavailable");
                        return;
                    }
                };
                if let Err(error) = pause_item.set_checked(paused) {
                    eprintln!("Disk: could not update animation menu: {error}");
                }
                if let Err(error) =
                    set_pause_animations(paused, app.clone(), app.state::<SettingsStore>())
                {
                    eprintln!("Disk: {error}");
                }
            }
            "start-with-windows" => {
                let was_enabled = match app.autolaunch().is_enabled() {
                    Ok(enabled) => enabled,
                    Err(error) => {
                        eprintln!("Disk: could not read start-with-Windows setting: {error}");
                        return;
                    }
                };
                let result = if was_enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };
                match result {
                    Ok(()) => {
                        if let Err(error) = startup_item.set_checked(!was_enabled) {
                            eprintln!("Disk: could not update startup menu: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("Disk: could not update start-with-Windows setting: {error}");
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg == "--background") {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.show() {
                    eprintln!("Disk: could not show existing instance: {error}");
                }
                if let Err(error) = window.set_focus() {
                    eprintln!("Disk: could not focus existing instance: {error}");
                }
                if let Err(error) = window.emit("widget-visibility", true) {
                    eprintln!("Disk: could not publish widget visibility: {error}");
                }
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let activated = shortcut.to_string();
                    let configured = {
                        let settings = app.state::<SettingsStore>();
                        settings
                            .data
                            .lock()
                            .map(|settings| settings.global_hotkey.clone())
                            .ok()
                    };
                    match configured {
                        Some(hotkey) if activated.eq_ignore_ascii_case(&hotkey) => {
                            if let Err(error) = toggle_widget(app.clone()) {
                                eprintln!("Disk: {error}");
                            }
                        }
                        Some(_) if activated.eq_ignore_ascii_case("control+alt+arrowleft") => {
                            if let Err(error) = cycle_mode(-1, app.clone()) {
                                eprintln!("Disk: {error}");
                            }
                        }
                        Some(_) if activated.eq_ignore_ascii_case("control+alt+arrowright") => {
                            if let Err(error) = cycle_mode(1, app.clone()) {
                                eprintln!("Disk: {error}");
                            }
                        }
                        Some(_) => {}
                        None => eprintln!("Disk: runtime settings are unavailable"),
                    }
                })
                .build(),
        )
        .manage(HitRegions::default())
        .manage(DragTracker::default())
        .manage(UiHeartbeat(Arc::new(Mutex::new(Instant::now()))))
        .manage(NativeQuietState::default())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            fs::create_dir_all(&config_dir)?;
            let path = config_dir.join("positions.json");
            let data = if path.exists() {
                serde_json::from_slice(&fs::read(&path)?)?
            } else {
                PositionData::default()
            };
            let positions = PositionStore {
                path,
                data: Arc::new(Mutex::new(data)),
            };
            app.manage(positions);

            let settings_path = config_dir.join("settings.json");
            let mut settings = if settings_path.exists() {
                serde_json::from_slice(&fs::read(&settings_path)?)?
            } else {
                RuntimeSettings::default()
            };
            settings.global_hotkey = Shortcut::from_str(&settings.global_hotkey)
                .map_err(|error| format!("Invalid configured global shortcut: {error}"))?
                .to_string();
            let settings_store = SettingsStore {
                path: settings_path,
                data: Arc::new(Mutex::new(settings)),
            };
            app.manage(settings_store);

            let window = app.get_webview_window("main").ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "Missing main window")
            })?;
            if let Err(error) = restore_position(&window, app.state::<PositionStore>().inner()) {
                eprintln!("Disk: {error}");
            }
            let hotkey = app
                .state::<SettingsStore>()
                .data
                .lock()
                .map_err(|_| "Runtime settings are unavailable")?
                .global_hotkey
                .clone();
            app.global_shortcut()
                .register(hotkey.as_str())
                .map_err(|error| format!("Could not register global shortcut {hotkey}: {error}"))?;
            app.global_shortcut()
                .register("Ctrl+Alt+ArrowLeft")
                .map_err(|error| format!("Could not register previous-mode shortcut: {error}"))?;
            app.global_shortcut()
                .register("Ctrl+Alt+ArrowRight")
                .map_err(|error| format!("Could not register next-mode shortcut: {error}"))?;
            build_tray(app)?;
            let background_start = std::env::args().any(|arg| arg == "--background");
            if !background_start {
                window.show()?;
            }
            start_native_loops(
                window,
                app.state::<HitRegions>(),
                app.state::<DragTracker>(),
                app.state::<PositionStore>(),
                app.state::<SettingsStore>(),
                app.state::<UiHeartbeat>(),
                app.state::<NativeQuietState>(),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_hit_regions,
            begin_disk_drag,
            toggle_widget,
            cycle_mode,
            get_runtime_settings,
            get_focus_assist_state,
            get_fullscreen_state,
            watchdog_ping,
            set_global_hotkey,
            set_pause_animations,
            save_current_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running Disk");
}
