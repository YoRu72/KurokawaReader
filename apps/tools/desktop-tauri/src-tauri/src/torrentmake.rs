//! A torrent made from bytes, for the self-test of torrent streaming (stage P4): SHA-1, bencoding, a .torrent's
//! `info` (single file or several), its info-hash, and an HTTP tracker's compact answer — so the test can make a
//! torrent of random bytes, seed it on loopback and stream it, with no real torrent and nothing fetched. std only;
//! `rustc --edition 2021 --test src/torrentmake.rs` runs the tests.

/* ---------- SHA-1 (FIPS 180-4) ---------- */

pub struct Sha1 {
    h: [u32; 5],
    buf: [u8; 64],
    fill: usize,
    len: u64,
}

impl Default for Sha1 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha1 {
    pub fn new() -> Sha1 {
        Sha1 { h: [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0], buf: [0; 64], fill: 0, len: 0 }
    }

    fn block(&mut self, b: &[u8]) {
        let mut w = [0u32; 80];
        for (i, wi) in w.iter_mut().enumerate().take(16) {
            *wi = u32::from_be_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut bb, mut c, mut d, mut e] = self.h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((bb & c) | (!bb & d), 0x5A827999),
                20..=39 => (bb ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((bb & c) | (bb & d) | (c & d), 0x8F1BBCDC),
                _ => (bb ^ c ^ d, 0xCA62C1D6u32),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = bb.rotate_left(30);
            bb = a;
            a = t;
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(bb);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.len = self.len.wrapping_add(data.len() as u64);
        if self.fill > 0 {
            let n = (64 - self.fill).min(data.len());
            self.buf[self.fill..self.fill + n].copy_from_slice(&data[..n]);
            self.fill += n;
            data = &data[n..];
            if self.fill == 64 {
                let b = self.buf;
                self.block(&b);
                self.fill = 0;
            }
        }
        while data.len() >= 64 {
            self.block(&data[..64]);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.fill = data.len();
        }
    }

    pub fn finish(mut self) -> [u8; 20] {
        let bits = self.len.wrapping_mul(8);
        self.update(&[0x80]);
        while self.fill != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 20];
        for (i, v) in self.h.iter().enumerate() {
            out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
        }
        out
    }
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut s = Sha1::new();
    s.update(data);
    s.finish()
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/* ---------- bencoding ---------- */

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum B {
    Int(i64),
    Bytes(Vec<u8>),
    List(Vec<B>),
    /// Keys are sorted when encoded (as the format requires).
    Dict(Vec<(Vec<u8>, B)>),
}

pub fn s(t: &str) -> B {
    B::Bytes(t.as_bytes().to_vec())
}

pub fn encode(b: &B, out: &mut Vec<u8>) {
    match b {
        B::Int(n) => out.extend_from_slice(format!("i{}e", n).as_bytes()),
        B::Bytes(x) => {
            out.extend_from_slice(format!("{}:", x.len()).as_bytes());
            out.extend_from_slice(x);
        }
        B::List(xs) => {
            out.push(b'l');
            for x in xs {
                encode(x, out);
            }
            out.push(b'e');
        }
        B::Dict(kv) => {
            let mut kv: Vec<&(Vec<u8>, B)> = kv.iter().collect();
            kv.sort_by(|a, b| a.0.cmp(&b.0));
            out.push(b'd');
            for (k, v) in kv {
                encode(&B::Bytes(k.clone()), out);
                encode(v, out);
            }
            out.push(b'e');
        }
    }
}

pub fn bencode(b: &B) -> Vec<u8> {
    let mut v = Vec::new();
    encode(b, &mut v);
    v
}

/* ---------- a torrent ---------- */

/// A torrent made: its .torrent bytes and its info-hash (hex, lower case).
pub struct Made {
    pub torrent: Vec<u8>,
    pub info_hash: String,
    // (The raw 20 bytes, for a peer handshake should a test need one; unread for now — CI's only warning here.)
    #[allow(dead_code)]
    pub info_hash_raw: [u8; 20],
}

/// The .torrent of `files` (name, bytes) — one file: a single-file torrent named after it; several: a folder `name`
/// holding them in that order —, cut into pieces of `piece_len`, announcing to `announce`, private when asked
/// (no DHT, no peer exchange: only the tracker's peers).
pub fn make(name: &str, files: &[(&str, &[u8])], piece_len: usize, announce: &str, private: bool) -> Made {
    let mut pieces: Vec<u8> = Vec::new();
    let mut cur = Sha1::new();
    let mut in_piece = 0usize;
    for (_, data) in files {
        let mut d: &[u8] = data;
        while !d.is_empty() {
            let n = (piece_len - in_piece).min(d.len());
            cur.update(&d[..n]);
            in_piece += n;
            d = &d[n..];
            if in_piece == piece_len {
                pieces.extend_from_slice(&std::mem::take(&mut cur).finish());
                in_piece = 0;
            }
        }
    }
    if in_piece > 0 {
        pieces.extend_from_slice(&cur.finish());
    }
    let mut info: Vec<(Vec<u8>, B)> = vec![
        (b"piece length".to_vec(), B::Int(piece_len as i64)),
        (b"pieces".to_vec(), B::Bytes(pieces)),
    ];
    if files.len() == 1 {
        info.push((b"name".to_vec(), s(files[0].0)));
        info.push((b"length".to_vec(), B::Int(files[0].1.len() as i64)));
    } else {
        info.push((b"name".to_vec(), s(name)));
        let list = files
            .iter()
            .map(|(n, d)| {
                B::Dict(vec![
                    (b"length".to_vec(), B::Int(d.len() as i64)),
                    (b"path".to_vec(), B::List(n.split('/').map(s).collect())),
                ])
            })
            .collect();
        info.push((b"files".to_vec(), B::List(list)));
    }
    if private {
        info.push((b"private".to_vec(), B::Int(1)));
    }
    let info = B::Dict(info);
    let raw = sha1(&bencode(&info));
    let torrent = bencode(&B::Dict(vec![
        (b"announce".to_vec(), s(announce)),
        (b"created by".to_vec(), s("Kurokawa Tools self-test")),
        (b"info".to_vec(), info),
    ]));
    Made { torrent, info_hash: hex(&raw), info_hash_raw: raw }
}

/// An HTTP tracker's answer: the peers in compact form (IPv4 + port, 6 bytes each).
pub fn tracker_reply(peers: &[([u8; 4], u16)], interval: i64) -> Vec<u8> {
    let mut compact = Vec::with_capacity(peers.len() * 6);
    for (ip, port) in peers {
        compact.extend_from_slice(ip);
        compact.extend_from_slice(&port.to_be_bytes());
    }
    bencode(&B::Dict(vec![
        (b"interval".to_vec(), B::Int(interval)),
        (b"complete".to_vec(), B::Int(peers.len() as i64)),
        (b"incomplete".to_vec(), B::Int(0)),
        (b"peers".to_vec(), B::Bytes(compact)),
    ]))
}

/// Made-up bytes (xorshift), the same for the same seed.
pub fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_vectors() {
        assert_eq!(hex(&sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(hex(&sha1(&million)), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
        // (Fed in odd slices: the same.)
        let mut h = Sha1::new();
        for c in million.chunks(997) {
            h.update(c);
        }
        assert_eq!(hex(&h.finish()), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    }

    #[test]
    fn bencoding() {
        assert_eq!(bencode(&B::Int(-3)), b"i-3e");
        assert_eq!(bencode(&s("spam")), b"4:spam");
        assert_eq!(bencode(&B::List(vec![s("a"), B::Int(1)])), b"l1:ai1ee");
        // (Keys sorted as bytes.)
        assert_eq!(bencode(&B::Dict(vec![(b"b".to_vec(), B::Int(1)), (b"a".to_vec(), B::Int(2))])), b"d1:ai2e1:bi1ee");
    }

    #[test]
    fn torrents() {
        let a = noise(100_000, 7);
        let b = noise(1_000, 8);
        assert_eq!(a, noise(100_000, 7));
        assert_ne!(a[..1000], b[..]);
        let m = make("set", &[("v.mp4", &a), ("sub/v.srt", &b)], 16384, "http://127.0.0.1:9/announce", true);
        let t = &m.torrent;
        let text = String::from_utf8_lossy(t);
        assert!(text.starts_with("d8:announce27:http://127.0.0.1:9/announce10:created by"));
        assert!(text.contains("5:filesld6:lengthi100000e4:pathl5:v.mp4eed6:lengthi1000e4:pathl3:sub5:v.srteee"));
        assert!(text.contains("7:privatei1e"));
        // (The info-hash is SHA-1 of the info dictionary as it stands in the file.)
        let at = t.windows(6).position(|w| w == b"4:info").unwrap() + 6;
        assert_eq!(m.info_hash, hex(&sha1(&t[at..t.len() - 1])));
        // (101000 bytes → 7 pieces of 16384, the last short; 20 bytes each.)
        assert!(text.contains("6:pieces140:"));
        let mut all = a.clone();
        all.extend_from_slice(&b);
        let p = t.windows(11).position(|w| w == b"6:pieces140").unwrap() + 12;
        assert_eq!(&t[p..p + 20], &sha1(&all[..16384]));
        assert_eq!(&t[p + 120..p + 140], &sha1(&all[6 * 16384..]));
        let one = make("x", &[("only.mkv", &b)], 16384, "http://h/a", false);
        let ot = String::from_utf8_lossy(&one.torrent);
        assert!(ot.contains("6:lengthi1000e4:name8:only.mkv"));
        assert!(!ot.contains("private"));
    }

    #[test]
    fn tracker() {
        let r = tracker_reply(&[([127, 0, 0, 1], 6881)], 60);
        assert_eq!(r, b"d8:completei1e10:incompletei0e8:intervali60e5:peers6:\x7f\x00\x00\x01\x1a\xe1e");
    }
}
