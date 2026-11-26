// PDF → Word, «In a folder» (Reader 0.68.0): the converted file and its fonts written into the folders the reader
// picked (kr_folder_pick), through ONE command that the page calls in steps — bridge.js's `saveFiles(o)`, an extra of
// this shell (Electron's keeps the page's ZIP). The rules are savelogic.rs's (std only, tested alone): every path stays
// inside the chosen folder, no file is written over another, a file already there with the same bytes is not written
// again, a file is put in place only when whole, and what a failed or cancelled save made is taken away.
//   { op: 'plan', dir, items: [{ rel, size, sha }] }          → { items: [{ rel, action: 'write' | 'same' }], newDirs: [name] }
//   { op: 'part', dir, rel, b64, first, last }                → true     (a piece of a file; the last puts it in place)
//   { op: 'undo', dir, rels: [rel], dirs: [name] }            → how many files were taken away
//   { op: 'open', p }                                         → true     (a folder shown in the system's file manager)
use serde_json::{json, Value};
use tauri::AppHandle;

use kurokawa_shell::{shell, util};

use crate::savelogic::{self, Action, Item};

fn text(o: &Value, k: &str) -> String {
    o.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn strings(o: &Value, k: &str) -> Vec<String> {
    o.get(k).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}

/// The command: see the top of this file.
#[tauri::command]
pub async fn kr_save_files(app: AppHandle, o: Value) -> Result<Value, String> {
    let op = text(&o, "op");
    match op.as_str() {
        "plan" => {
            let dir = std::path::PathBuf::from(text(&o, "dir"));
            let items: Vec<Item> = o
                .get("items")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .map(|x| Item { rel: text(x, "rel"), size: x.get("size").and_then(|s| s.as_u64()).unwrap_or(0), sha: text(x, "sha") })
                        .collect()
                })
                .unwrap_or_default();
            // (Reading the files already there to compare them can take a while: off the async runtime's threads.)
            let planned = tauri::async_runtime::spawn_blocking(move || savelogic::plan(&dir, &items)).await.map_err(|e| e.to_string())??;
            let list: Vec<Value> = planned
                .0
                .iter()
                .map(|a| match a {
                    Action::Write(r) => json!({ "rel": r, "action": "write" }),
                    Action::Same(r) => json!({ "rel": r, "action": "same" }),
                })
                .collect();
            Ok(json!({ "items": list, "newDirs": planned.1 }))
        }
        "part" => {
            let dir = std::path::PathBuf::from(text(&o, "dir"));
            let bytes = util::b64_decode(&text(&o, "b64"));
            let first = o.get("first").and_then(|v| v.as_bool()).unwrap_or(false);
            let last = o.get("last").and_then(|v| v.as_bool()).unwrap_or(false);
            savelogic::put(&dir, &text(&o, "rel"), &bytes, first, last)?;
            Ok(Value::Bool(true))
        }
        "undo" => {
            let dir = std::path::PathBuf::from(text(&o, "dir"));
            let n = savelogic::undo(&dir, &strings(&o, "rels"), &strings(&o, "dirs"));
            Ok(json!(n))
        }
        "open" => {
            let p = text(&o, "p");
            if !std::path::Path::new(&p).is_dir() {
                return Err("not a folder".to_string());
            }
            shell::open_path(&app, p)?;
            Ok(Value::Bool(true))
        }
        _ => Err("unknown save step".to_string()),
    }
}
