//! A command-line front for the Rust extraction engine, built from the std-only modules (no Cargo), so
//! tests/extractsafe.cjs can hand jobs between the two engines: a job the JavaScript engine started and was killed in is
//! finished, restored or undone here, and the reverse. Stored entries only (std has no inflate: the tests' archives keep
//! their bytes stored). Not part of the crate.
//!   extractjob_cli extract <archive> <dest> <registry> <inPlace 0|1> <crash at n, 0: none>
//!   extractjob_cli finish|restore|undo <journal>
//! → one line: the engine's JSON answer, or «ERR <message>» (a crash: «CRASH <point>»).
#[path = "../src/archsafe.rs"]
pub mod archsafe;
#[path = "../src/vidjson.rs"]
pub mod vidjson;
#[path = "../src/extractjob.rs"]
pub mod extractjob;

use extractjob::*;
use std::cell::Cell;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

struct Stored;
impl Codec for Stored {
    fn inflate(&self, _src: &mut dyn Read, _dst: &mut dyn Write) -> io::Result<u64> {
        Err(io::Error::other("deflate is not built into this test program"))
    }
    fn deflate(&self, _data: &[u8], _level: u32, _mem: u32) -> Option<Vec<u8>> {
        None
    }
}
struct Kill {
    at: usize,
    hits: Cell<usize>,
}
impl Io for Kill {
    fn free_space(&self, _d: &Path) -> i64 {
        -1
    }
    fn crash(&self, p: &str) -> Result<(), Fail> {
        self.hits.set(self.hits.get() + 1);
        if self.at > 0 && self.hits.get() == self.at {
            return Err(Fail::crash(p));
        }
        Ok(())
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let arg = |i: usize| a.get(i).cloned().unwrap_or_default();
    let io = Kill { at: arg(6).parse().unwrap_or(0), hits: Cell::new(0) };
    let mut env = Env::new(&io, &Stored);
    env.batch_count = 3;
    let pr = Pr { on: &|_, _, _| {}, stopped: &|| false };
    let r = match arg(1).as_str() {
        "extract" => {
            let o = Opts { in_place: arg(5) == "1", registry: Some(PathBuf::from(arg(4))), ..Default::default() };
            extract(Path::new(&arg(2)), Path::new(&arg(3)), &o, &env, &pr)
        }
        "finish" => finish(Path::new(&arg(2)), &env, &pr, None, 0),
        "restore" => restore(Path::new(&arg(2)), &env),
        "undo" => undo(Path::new(&arg(2)), &env),
        x => Err(Fail::new(format!("unknown act {}", x))),
    };
    match r {
        Ok(j) => println!("{}", j.to_json()),
        Err(e) if e.crash => println!("CRASH {}", e.msg),
        Err(e) => println!("ERR {}", e.msg),
    }
}
