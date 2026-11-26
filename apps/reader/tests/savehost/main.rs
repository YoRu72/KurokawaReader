// A command-line host for desktop-tauri/src-tauri/src/savelogic.rs (the Rust shell's real folder-writing rules, std only),
// so tests/pdf2docxfontsout.cjs can run the page's save against them in a real folder:
//   savehost plan <dir> <rel>\t<size>\t<sha> …   → one line per file: «write\t<rel>» or «same\t<rel>»; then «newdir\t<name>» lines
//   savehost part <dir> <rel> <first 0|1> <last 0|1>   (the piece's bytes on stdin)
//   savehost undo <dir>                                 (stdin: «f\t<rel>» and «d\t<name>» lines) → the number of files taken away
// An error: its text on stderr and exit code 1. (rustc --edition 2021 tests/savehost/main.rs -o <out>)
#[path = "../../desktop-tauri/src-tauri/src/savelogic.rs"]
mod savelogic;
use std::io::Read;
use std::path::PathBuf;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let fail = |m: String| -> ! {
        eprintln!("{}", m);
        std::process::exit(1)
    };
    if a.len() < 3 {
        fail("usage".into());
    }
    let dir = PathBuf::from(&a[2]);
    match a[1].as_str() {
        "plan" => {
            let items: Vec<savelogic::Item> = a[3..]
                .iter()
                .map(|x| {
                    let p: Vec<&str> = x.split('\t').collect();
                    savelogic::Item { rel: p[0].to_string(), size: p.get(1).and_then(|s| s.parse().ok()).unwrap_or(0), sha: p.get(2).unwrap_or(&"").to_string() }
                })
                .collect();
            match savelogic::plan(&dir, &items) {
                Ok((acts, nd)) => {
                    for x in acts {
                        match x {
                            savelogic::Action::Write(r) => println!("write\t{}", r),
                            savelogic::Action::Same(r) => println!("same\t{}", r),
                        }
                    }
                    for d in nd {
                        println!("newdir\t{}", d);
                    }
                }
                Err(e) => fail(e),
            }
        }
        "part" => {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            if let Err(e) = savelogic::put(&dir, &a[3], &bytes, a[4] == "1", a[5] == "1") {
                fail(e);
            }
        }
        "undo" => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).unwrap();
            let (mut rels, mut dirs) = (Vec::new(), Vec::new());
            for l in text.lines() {
                match l.split_once('\t') {
                    Some(("f", r)) => rels.push(r.to_string()),
                    Some(("d", r)) => dirs.push(r.to_string()),
                    _ => {}
                }
            }
            println!("{}", savelogic::undo(&dir, &rels, &dirs));
        }
        _ => fail("unknown".into()),
    }
}
