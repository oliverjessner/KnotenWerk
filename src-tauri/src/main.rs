#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const GRAPHS_DIR: &str = "graphs";

#[derive(Serialize)]
struct GraphFileEntry {
    name: String,
    path: String,
    #[serde(rename = "lastModifiedMs")]
    last_modified_ms: Option<u64>,
}

#[derive(Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

fn app_graphs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(GRAPHS_DIR))
        .map_err(|error| error.to_string())
}

fn validate_graph_id(graph_id: &str) -> Result<(), String> {
    let valid = !graph_id.is_empty()
        && graph_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');

    if valid {
        Ok(())
    } else {
        Err("invalid graph id".into())
    }
}

fn graph_file_path(app: &AppHandle, graph_id: &str) -> Result<PathBuf, String> {
    validate_graph_id(graph_id)?;
    Ok(app_graphs_dir(app)?.join(format!("{graph_id}.json")))
}

fn modified_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[tauri::command]
fn ensure_graphs_directory(app: AppHandle) -> Result<String, String> {
    let dir = app_graphs_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    app.path()
        .app_data_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn graph_file_exists(app: AppHandle, graph_id: String) -> Result<bool, String> {
    Ok(graph_file_path(&app, &graph_id)?.is_file())
}

#[tauri::command]
fn list_graph_files(app: AppHandle) -> Result<Vec<GraphFileEntry>, String> {
    let dir = app_graphs_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }

        entries.push(GraphFileEntry {
            path: format!("{GRAPHS_DIR}/{name}"),
            name,
            last_modified_ms: metadata.modified().ok().and_then(modified_ms),
        });
    }

    Ok(entries)
}

#[tauri::command]
fn read_graph_file(app: AppHandle, graph_id: String) -> Result<String, String> {
    fs::read_to_string(graph_file_path(&app, &graph_id)?).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_graph_file(app: AppHandle, graph_id: String, contents: String) -> Result<(), String> {
    let path = graph_file_path(&app, &graph_id)?;
    let dir = app_graphs_dir(&app)?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_graph_file(app: AppHandle, graph_id: String) -> Result<(), String> {
    let path = graph_file_path(&app, &graph_id)?;
    if path.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn export_text_file(
    app: AppHandle,
    title: String,
    default_path: String,
    filters: Vec<DialogFilter>,
    contents: String,
) -> Result<bool, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(default_path);

    for filter in &filters {
        let extensions = filter
            .extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }

    let Some(path) = dialog.blocking_save_file() else {
        return Ok(false);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn import_text_file(
    app: AppHandle,
    title: String,
    filters: Vec<DialogFilter>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(title);

    for filter in &filters {
        let extensions = filter
            .extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }

    let Some(path) = dialog.blocking_pick_file() else {
        return Ok(None);
    };

    let path = path.into_path().map_err(|error| error.to_string())?;
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ensure_graphs_directory,
            graph_file_exists,
            list_graph_files,
            read_graph_file,
            write_graph_file,
            delete_graph_file,
            export_text_file,
            import_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
