// kt:hashFile: md5, sha1 and sha256 of a file in one pass, read 1 MiB at a time.
use std::fs::File;
use std::io::Read;

use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::util::hex;

pub struct Hashes {
    pub md5: String,
    pub sha1: String,
    pub sha256: String,
    pub size: u64,
}

pub fn hash_file(p: &str) -> Result<Hashes, String> {
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let mut m5 = Md5::new();
    let mut s1 = Sha1::new();
    let mut s256 = Sha256::new();
    let mut buf: Vec<u8> = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        m5.update(&buf[..n]);
        s1.update(&buf[..n]);
        s256.update(&buf[..n]);
    }
    let size = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
    let a = m5.finalize();
    let b = s1.finalize();
    let c = s256.finalize();
    Ok(Hashes {
        md5: hex(a.as_slice()),
        sha1: hex(b.as_slice()),
        sha256: hex(c.as_slice()),
        size,
    })
}
