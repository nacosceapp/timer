#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

// The window is frameless in both layouts. Keeping this mode separately avoids
// treating ordinary full-window moves as a miniature-position update.
struct WindowMode(Arc<AtomicBool>);

#[derive(serde::Serialize, serde::Deserialize)]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MiniPosition {
    x: i32,
    y: i32,
}

fn mini_position_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("mini-position.json"))
}

fn save_mini_position_to_disk(app: &AppHandle, position: &MiniPosition) -> Result<(), String> {
    let path = mini_position_path(app)?;
    let contents = serde_json::to_string(position).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_mini_position(app: AppHandle) -> Result<Option<MiniPosition>, String> {
    let path = mini_position_path(&app)?;
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn get_window_bounds(window: WebviewWindow) -> Result<WindowBounds, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    // `set_size` sets the client area. Pair it with `inner_size`, not
    // `outer_size`, otherwise Windows' invisible resize border is added again
    // on every miniature-to-full restore.
    let size = window.inner_size().map_err(|error| error.to_string())?;
    Ok(WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

#[tauri::command]
fn set_window_position(window: WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_mini_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    save_mini_position_to_disk(&app, &MiniPosition { x, y })
}

#[tauri::command]
fn restore_window_bounds(window: WebviewWindow, bounds: WindowBounds) -> Result<(), String> {
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
            bounds.width,
            bounds.height,
        )))
        .map_err(|error| error.to_string())?;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            bounds.x, bounds.y,
        )))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_compact_window(
    window: WebviewWindow,
    window_mode: tauri::State<'_, WindowMode>,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        window
            .set_size(tauri::Size::Logical(tauri::LogicalSize::new(180.0, 72.0)))
            .map_err(|error| error.to_string())?;
    }

    // Resize before enabling persistence. Windows may emit a Moved event while
    // compacting; that is the full window's coordinate, not the user's saved
    // miniature coordinate.
    window_mode.0.store(enabled, Ordering::Relaxed);

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(WindowMode(Arc::new(AtomicBool::new(false))))
        .invoke_handler(tauri::generate_handler![
            load_mini_position,
            save_mini_position,
            get_window_bounds,
            set_window_position,
            restore_window_bounds,
            set_always_on_top,
            start_dragging,
            minimize_window,
            close_window,
            set_compact_window
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("NAC OSCE Timer");
                let app_handle = app.handle().clone();
                let compact_mode = app.state::<WindowMode>().0.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Moved(position) = event {
                        if compact_mode.load(Ordering::Relaxed) {
                            let _ = save_mini_position_to_disk(
                                &app_handle,
                                &MiniPosition {
                                    x: position.x,
                                    y: position.y,
                                },
                            );
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NAC OSCE Timer");
}
