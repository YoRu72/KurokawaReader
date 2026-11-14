// A MEGA file fetched whole as MEGA keeps it (encrypted), decrypted in place — desktop/main.cjs's kt:megaDecrypt:
// AES-128-CTR, the key the node key's two halves XORed, the counter's first half the key's third quarter (its second
// half zero, the whole 16 bytes counted up as one big-endian number, as Node's aes-128-ctr does). Written beside the
// file («<file>.kt-mega»), then put in its place. AES itself here (FIPS-197, T-tables made at first use), so no crate is
// needed. Std only, checked alone: `rustc --edition 2021 --test mega.rs`.
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::OnceLock;

/* ---------- AES-128 ---------- */

struct Tables {
    sbox: [u8; 256],
    t: [[u32; 256]; 4],
}

fn xtime(x: u8) -> u8 {
    (x << 1) ^ if x & 0x80 != 0 { 0x1b } else { 0 }
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        // (The S-box from the multiplicative inverse in GF(2^8) and the affine map — FIPS-197 §5.1.1.)
        let mut sbox = [0u8; 256];
        let (mut p, mut q): (u8, u8) = (1, 1);
        loop {
            p = p ^ (p << 1) ^ if p & 0x80 != 0 { 0x1b } else { 0 };
            q ^= q << 1;
            q ^= q << 2;
            q ^= q << 4;
            if q & 0x80 != 0 {
                q ^= 0x09;
            }
            let x = q ^ q.rotate_left(1) ^ q.rotate_left(2) ^ q.rotate_left(3) ^ q.rotate_left(4);
            sbox[p as usize] = x ^ 0x63;
            if p == 1 {
                break;
            }
        }
        sbox[0] = 0x63;
        let mut t = [[0u32; 256]; 4];
        for i in 0..256 {
            let s = sbox[i];
            let s2 = xtime(s);
            let s3 = s2 ^ s;
            let w = (s2 as u32) << 24 | (s as u32) << 16 | (s as u32) << 8 | s3 as u32;
            t[0][i] = w;
            t[1][i] = w.rotate_right(8);
            t[2][i] = w.rotate_right(16);
            t[3][i] = w.rotate_right(24);
        }
        Tables { sbox, t }
    })
}

/// An AES-128 key, expanded.
pub struct Aes128 {
    rk: [u32; 44],
}

impl Aes128 {
    pub fn new(key: &[u8; 16]) -> Aes128 {
        let sb = &tables().sbox;
        let mut rk = [0u32; 44];
        for i in 0..4 {
            rk[i] = u32::from_be_bytes([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
        }
        let mut rcon: u8 = 1;
        for i in 4..44 {
            let mut w = rk[i - 1];
            if i % 4 == 0 {
                w = w.rotate_left(8);
                let b = w.to_be_bytes();
                w = u32::from_be_bytes([sb[b[0] as usize], sb[b[1] as usize], sb[b[2] as usize], sb[b[3] as usize]]);
                w ^= (rcon as u32) << 24;
                rcon = xtime(rcon);
            }
            rk[i] = rk[i - 4] ^ w;
        }
        Aes128 { rk }
    }

    /// One 16-byte block encrypted.
    pub fn encrypt(&self, block: &[u8; 16]) -> [u8; 16] {
        let tb = tables();
        let (t, sb) = (&tb.t, &tb.sbox);
        let rk = &self.rk;
        let mut s = [0u32; 4];
        for i in 0..4 {
            s[i] = u32::from_be_bytes([block[4 * i], block[4 * i + 1], block[4 * i + 2], block[4 * i + 3]]) ^ rk[i];
        }
        for r in 1..10 {
            let mut n = [0u32; 4];
            for i in 0..4 {
                n[i] = t[0][(s[i] >> 24) as usize]
                    ^ t[1][((s[(i + 1) % 4] >> 16) & 0xff) as usize]
                    ^ t[2][((s[(i + 2) % 4] >> 8) & 0xff) as usize]
                    ^ t[3][(s[(i + 3) % 4] & 0xff) as usize]
                    ^ rk[4 * r + i];
            }
            s = n;
        }
        let mut out = [0u8; 16];
        for i in 0..4 {
            let w = (sb[(s[i] >> 24) as usize] as u32) << 24
                | (sb[((s[(i + 1) % 4] >> 16) & 0xff) as usize] as u32) << 16
                | (sb[((s[(i + 2) % 4] >> 8) & 0xff) as usize] as u32) << 8
                | sb[(s[(i + 3) % 4] & 0xff) as usize] as u32;
            out[4 * i..4 * i + 4].copy_from_slice(&(w ^ rk[40 + i]).to_be_bytes());
        }
        out
    }
}

/// AES-128-CTR: the stream XORed onto the bytes as they pass, the counter carried between calls.
pub struct Ctr {
    aes: Aes128,
    counter: [u8; 16],
    pad: [u8; 16],
    used: usize,
}

impl Ctr {
    pub fn new(key: &[u8; 16], iv: &[u8; 16]) -> Ctr {
        Ctr { aes: Aes128::new(key), counter: *iv, pad: [0; 16], used: 16 }
    }
    pub fn apply(&mut self, data: &mut [u8]) {
        for b in data.iter_mut() {
            if self.used == 16 {
                self.pad = self.aes.encrypt(&self.counter);
                for i in (0..16).rev() {
                    self.counter[i] = self.counter[i].wrapping_add(1);
                    if self.counter[i] != 0 {
                        break;
                    }
                }
                self.used = 0;
            }
            *b ^= self.pad[self.used];
            self.used += 1;
        }
    }
}

/* ---------- MEGA's key ---------- */

/// Base64 as MEGA writes it (URL-safe, unpadded; the standard alphabet and padding taken too).
pub fn b64url_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// The file key (32 bytes, base64) → the AES key and the counter's start; None when it is not a file key.
pub fn key_parts(key_b64: &str) -> Option<([u8; 16], [u8; 16])> {
    let k = b64url_decode(key_b64);
    if k.len() != 32 {
        return None;
    }
    let mut key = [0u8; 16];
    for i in 0..16 {
        key[i] = k[i] ^ k[i + 16];
    }
    let mut iv = [0u8; 16];
    iv[..8].copy_from_slice(&k[16..24]);
    Some((key, iv))
}

/// `path` decrypted in place: written to «<path>.kt-mega», then put in its place.
pub fn decrypt_file(path: &Path, key_b64: &str) -> Result<(), String> {
    let (key, iv) = key_parts(key_b64).ok_or_else(|| "mega: key".to_string())?;
    let tmp = {
        let mut s = path.as_os_str().to_os_string();
        s.push(".kt-mega");
        std::path::PathBuf::from(s)
    };
    let r: io::Result<()> = (|| {
        let mut input = fs::File::open(path)?;
        let mut out = fs::File::create(&tmp)?;
        let mut ctr = Ctr::new(&key, &iv);
        let mut b = vec![0u8; 1 << 20];
        loop {
            let n = input.read(&mut b)?;
            if n == 0 {
                break;
            }
            ctr.apply(&mut b[..n]);
            out.write_all(&b[..n])?;
        }
        out.flush()?;
        Ok(())
    })();
    if let Err(e) = r {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn fips197() {
        // (FIPS-197 appendix C.1.)
        let k: [u8; 16] = unhex("000102030405060708090a0b0c0d0e0f").try_into().unwrap();
        let p: [u8; 16] = unhex("00112233445566778899aabbccddeeff").try_into().unwrap();
        assert_eq!(hex(&Aes128::new(&k).encrypt(&p)), "69c4e0d86a7b0430d8cdb78070b4c55a");
        // (Appendix B.)
        let k: [u8; 16] = unhex("2b7e151628aed2a6abf7158809cf4f3c").try_into().unwrap();
        let p: [u8; 16] = unhex("3243f6a8885a308d313198a2e0370734").try_into().unwrap();
        assert_eq!(hex(&Aes128::new(&k).encrypt(&p)), "3925841d02dc09fbdc118597196a0b32");
    }

    #[test]
    fn ctr_sp800_38a() {
        // (NIST SP 800-38A F.5.1, CTR-AES128.Encrypt.)
        let k: [u8; 16] = unhex("2b7e151628aed2a6abf7158809cf4f3c").try_into().unwrap();
        let iv: [u8; 16] = unhex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff").try_into().unwrap();
        let mut d = unhex("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710");
        // (In uneven pieces: the counter and the pad carried over.)
        let mut c = Ctr::new(&k, &iv);
        let (a, rest) = d.split_at_mut(5);
        c.apply(a);
        let (b, rest2) = rest.split_at_mut(27);
        c.apply(b);
        c.apply(rest2);
        assert_eq!(hex(&d), "874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff5ae4df3edbd5d35e5b4f09020db03eab1e031dda2fbe03d1792170a0f3009cee");
        // (The counter carried across a byte that wraps: all of it counted as one number.)
        let iv2: [u8; 16] = unhex("000000000000000000000000000000ff").try_into().unwrap();
        let mut x = vec![0u8; 32];
        Ctr::new(&k, &iv2).apply(&mut x);
        let second = Aes128::new(&k).encrypt(&unhex("00000000000000000000000000000100").try_into().unwrap());
        assert_eq!(&x[16..], &second[..]);
    }

    #[test]
    fn mega_file() {
        let key: Vec<u8> = (0u8..32).map(|i| i.wrapping_mul(7).wrapping_add(3)).collect();
        let b64: String = {
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut s = String::new();
            for ch in key.chunks(3) {
                let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
                for i in 0..(ch.len() + 1) {
                    s.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
                }
            }
            s
        };
        assert_eq!(b64url_decode(&b64), key);
        let (k, iv) = key_parts(&b64).unwrap();
        assert_eq!(k[0], key[0] ^ key[16]);
        assert_eq!(&iv[..8], &key[16..24]);
        assert_eq!(&iv[8..], &[0u8; 8]);
        assert!(key_parts("AAAA").is_none());
        // (What Node's createDecipheriv('aes-128-ctr', key, iv) gives for 40 zero bytes with this key — main.cjs's.)
        let mut z = vec![0u8; 40];
        Ctr::new(&k, &iv).apply(&mut z);
        assert_eq!(hex(&z), "8e18b9b0561cb06749067e26ddafd8d0261e8189f9f84affd1f3f31a549313801aa391fed27e3032");
        let d = std::env::temp_dir().join(format!("kt-mega-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let f = d.join("v.bin");
        let plain: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let mut enc = plain.clone();
        Ctr::new(&k, &iv).apply(&mut enc);
        fs::write(&f, &enc).unwrap();
        decrypt_file(&f, &b64).unwrap();
        assert!(fs::read(&f).unwrap() == plain);
        assert!(!d.join("v.bin.kt-mega").exists());
        assert!(decrypt_file(&f, "short").is_err());
        let _ = fs::remove_dir_all(&d);
    }
}
