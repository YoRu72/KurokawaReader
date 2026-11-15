//! Stage M4: the screen translator's and the HLS reader's methods. Pixel and text-heavy calls are `bytes.*` (one copy
//! in, one copy out, no JSON and no base64 for a screenful of text or a patch of pixels); the small ones are JSON.
//! - `bytes.scrTrack`: KtScreenTrack.update (kt-core screentrack) over the binary request Java writes.
//! - `bytes.moShift`: KtScreenMotion.shift over two signatures (i16 little-endian).
//! - `bytes.inpaint`: KtInpaint.clean over ARGB words (little-endian); `cache: true` goes through the patch cache.
//! - `bytes.hlsVariants`, `bytes.hlsMedia`: KtHls's playlists (UTF-16LE text in, binary out); `hls.choose`.
//! - `scr.ahead`, `lt.kinds`, `lt.restore`, `lt.prompt`: for the shadow check only (they stay on Java: see
//!   ANDROID-PORT.md, M4).
//! - `scr.stats`, `scr.cacheClear`: the patch cache's figures.
//! No unsafe code.

use crate::dispatch::{boolean, field, int, num, string};
use kt_core::hls;
use kt_core::inpaint::{self, PatchCache};
use kt_core::lettering;
use kt_core::screenmotion;
use kt_core::screentrack::{self, Cand, Conf};
use kt_core::vidjson::J;
use std::sync::{Mutex, MutexGuard, OnceLock};

fn cache() -> MutexGuard<'static, PatchCache> {
    static C: OnceLock<Mutex<PatchCache>> = OnceLock::new();
    // (8 MB: some forty speech balloons of a phone screen, input and output.)
    C.get_or_init(|| Mutex::new(PatchCache::new(8 << 20))).lock().unwrap_or_else(|e| e.into_inner())
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn text16(u: &[u16]) -> J {
    J::Str(String::from_utf16_lossy(u))
}
fn arr<'a>(a: &'a J, k: &str) -> Result<&'a Vec<J>, String> {
    field(a, k)?.as_arr().ok_or_else(|| format!("args: «{}» not a list", k))
}
fn item_int(v: &J) -> Result<i64, String> {
    match v {
        J::Num(n, _) if n.fract() == 0.0 => Ok(*n as i64),
        _ => Err("args: a list holds a bad number".into()),
    }
}
fn item_str(v: &J) -> Result<Option<String>, String> {
    match v {
        J::Null => Ok(None),
        J::Str(s) => Ok(Some(s.clone())),
        _ => Err("args: a list holds a bad string".into()),
    }
}
fn base_of(a: &J) -> Result<hls::JUrl, String> {
    hls::resolve(None, &units(&string(a, "base")?))
}
fn dim(a: &J, k: &str) -> Result<usize, String> {
    let v = int(a, k)?;
    if !(0..=1 << 15).contains(&v) {
        return Err(format!("args: «{}» out of range", k));
    }
    Ok(v as usize)
}

pub fn call_raw(m: &str, args: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(args).map_err(|_| "args: not UTF-8".to_string())?;
    let a = &(if text.trim().is_empty() { J::Obj(Vec::new()) } else { kt_core::vidjson::parse(text)? });
    match m {
        "bytes.scrTrack" => {
            let area = match a.get("area") {
                None | Some(J::Null) => None,
                Some(J::Arr(v)) if v.len() == 4 => {
                    let mut r = [0i32; 4];
                    for (k, x) in v.iter().enumerate() {
                        r[k] = item_int(x)? as i32;
                    }
                    Some(r)
                }
                Some(_) => return Err("args: «area» not four numbers".into()),
            };
            let c = Conf { vw: int(a, "vw")? as i32, vh: int(a, "vh")? as i32, keep_misses: int(a, "keepMisses")? as i32, keep_off: boolean(a, "keepOff")?, cap: int(a, "cap")? as i32, area };
            let (items, obs) = screentrack::read_request(data)?;
            Ok(screentrack::write_answer(&screentrack::update(&items, &obs, &c)))
        }
        "bytes.moShift" => {
            let rows = dim(a, "rows")?;
            let (x, y) = screenmotion::split_pair(data, rows)?;
            Ok(screenmotion::shift(&x, &y, int(a, "maxPx")? as i32).to_le_bytes().to_vec())
        }
        "bytes.inpaint" => {
            let (w, h) = (dim(a, "w")?, dim(a, "h")?);
            if boolean(a, "cache")? {
                cache().clean_bytes(data, w, h)
            } else {
                Ok(inpaint::bytes(&inpaint::clean(&inpaint::words(data)?, w, h)))
            }
        }
        "bytes.hlsVariants" => Ok(hls::write_variants(&hls::variants(&hls::units_le(data)?, &base_of(a)?)?)),
        "bytes.hlsMedia" => Ok(hls::write_playlist(&hls::media(&hls::units_le(data)?, &base_of(a)?)?)),
        _ => Err(format!("no such method: {}", m)),
    }
}

pub fn call(m: &str, a: &J) -> Result<J, String> {
    match m {
        "hls.choose" => {
            let vs = arr(a, "vs")?
                .iter()
                .map(|p| match p.as_arr().map(|x| x.as_slice()) {
                    Some([h, b]) => Ok((item_int(h)? as i32, item_int(b)? as i32)),
                    _ => Err("args: «vs» holds a bad pair".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(match hls::choose(&vs, int(a, "want")? as i32) {
                Some(k) => num(k as i64),
                None => J::Null,
            })
        }
        "scr.ahead" => {
            let cs = arr(a, "cands")?
                .iter()
                .map(|c| match c.as_arr().map(|x| x.as_slice()) {
                    Some([t, o, on, top, bottom, n, known]) => Ok(Cand {
                        text: units(&item_str(t)?.unwrap_or_default()),
                        order: item_int(o)? as i32,
                        on: on.truthy(),
                        top: item_int(top)? as i32,
                        bottom: item_int(bottom)? as i32,
                        norm: units(&item_str(n)?.unwrap_or_default()),
                        known: known.truthy(),
                    }),
                    _ => Err("args: «cands» holds a bad candidate".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let got = screentrack::ahead(&cs, int(a, "vh")? as i32, int(a, "dir")? as i32, int(a, "max")? as i32, int(a, "maxChars")? as i32, int(a, "screensMilli")? as f64 / 1000.0);
            Ok(J::Arr(got.into_iter().map(|k| num(k as i64)).collect()))
        }
        "lt.kinds" => {
            let bs = arr(a, "blocks")?
                .iter()
                .map(|b| match b.as_arr().map(|x| x.as_slice()) {
                    Some([t, h, bg, g]) => Ok(lettering::Block { text: units(&item_str(t)?.unwrap_or_default()), height: item_int(h)? as i32, bg: item_int(bg)? as i32, glossary_kind: item_str(g)? }),
                    _ => Err("args: «blocks» holds a bad block".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(J::Arr(lettering::kinds(&bs).iter().map(|k| J::s(k)).collect()))
        }
        "lt.restore" => {
            let used = arr(a, "used")?
                .iter()
                .map(|p| match p.as_arr().map(|x| x.as_slice()) {
                    Some([n, J::Str(t)]) => Ok((item_int(n)?, units(t))),
                    _ => Err("args: «used» holds a bad pair".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = Vec::new();
            for t in arr(a, "texts")? {
                out.push(match item_str(t)? {
                    None => J::Null,
                    Some(s) => text16(&lettering::restore(&units(&s), &used)?),
                });
            }
            Ok(J::Arr(out))
        }
        "lt.prompt" => {
            let g = arr(a, "g")?
                .iter()
                .map(|p| match p.as_arr().map(|x| x.as_slice()) {
                    Some([J::Str(f), J::Str(t)]) => Ok((units(f), units(t))),
                    _ => Err("args: «g» holds a bad pair".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(text16(&lettering::prompt(&g)))
        }
        "scr.stats" => {
            let c = cache();
            Ok(J::Obj(vec![
                ("cacheHits".to_string(), num(c.hits as i64)),
                ("cacheMisses".to_string(), num(c.misses as i64)),
                ("cacheBytes".to_string(), num(c.bytes_held() as i64)),
                ("cacheItems".to_string(), num(c.len() as i64)),
            ]))
        }
        "scr.cacheClear" => {
            cache().clear();
            Ok(J::Bool(true))
        }
        _ => Err(format!("no such method: {}", m)),
    }
}

#[cfg(test)]
mod tests {
    use crate::dispatch::call_bytes;

    fn json(m: &str, args: &str) -> Result<String, String> {
        call_bytes(m.as_bytes(), args.as_bytes(), &[]).map(|b| String::from_utf8(b).unwrap())
    }

    #[test]
    fn small_methods() {
        assert_eq!(json("hls.choose", r#"{"vs":[[720,1],[360,2],[1080,3]],"want":480}"#).unwrap(), r#"{"r":1}"#);
        assert_eq!(json("hls.choose", r#"{"vs":[],"want":0}"#).unwrap(), r#"{"r":null}"#);
        assert_eq!(json("lt.prompt", r#"{"g":[["a","b"]]}"#).unwrap(), "{\"r\":\"\\n\\nGlossary — always translate these terms exactly this way:\\na → b\"}");
        assert_eq!(json("lt.restore", r#"{"texts":["x [[0]]",null],"used":[[0,"y"]]}"#).unwrap(), r#"{"r":["x y",null]}"#);
        assert_eq!(json("lt.kinds", r#"{"blocks":[["(hm)",40,0,null],["x",40,0,"sign"]]}"#).unwrap(), r#"{"r":["thought","sign"]}"#);
        let a = json("scr.ahead", r#"{"cands":[["On",0,true,0,60,"On",false],[" Next ",1,false,0,0,"Next",false]],"vh":2400,"dir":1,"max":5,"maxChars":100,"screensMilli":2000}"#).unwrap();
        assert_eq!(a, r#"{"r":[1]}"#);
        assert!(json("scr.ahead", r#"{"cands":[[1]],"vh":1,"dir":1,"max":1,"maxChars":1,"screensMilli":1000}"#).is_err());
        assert!(json("scr.stats", "{}").unwrap().contains("cacheHits"));
    }

    #[test]
    fn bytes_methods() {
        // Two signatures of 8 rows, all one value: standing still.
        let sig = vec![0u8; 2 * 24 * 8 * 2];
        assert_eq!(call_bytes(b"bytes.moShift", br#"{"rows":8,"maxPx":64}"#, &sig).unwrap(), 0i32.to_le_bytes().to_vec());
        assert!(call_bytes(b"bytes.moShift", br#"{"rows":9,"maxPx":64}"#, &sig).is_err());
        // A 4 × 4 white patch: unchanged, the same through the cache, twice.
        let px: Vec<u8> = std::iter::repeat(0xFFu8).take(64).collect();
        assert_eq!(call_bytes(b"bytes.inpaint", br#"{"w":4,"h":4,"cache":false}"#, &px).unwrap(), px);
        assert_eq!(call_bytes(b"bytes.inpaint", br#"{"w":4,"h":4,"cache":true}"#, &px).unwrap(), px);
        assert_eq!(call_bytes(b"bytes.inpaint", br#"{"w":4,"h":4,"cache":true}"#, &px).unwrap(), px);
        assert!(call_bytes(b"bytes.inpaint", br#"{"w":4,"h":4,"cache":true}"#, &px[..3]).is_err());
        // A tracking request with nothing followed and nothing read.
        let mut rq = Vec::new();
        rq.extend_from_slice(&0i32.to_le_bytes());
        rq.extend_from_slice(&0i32.to_le_bytes());
        let ans = call_bytes(b"bytes.scrTrack", br#"{"vw":1080,"vh":2400,"keepMisses":1,"keepOff":true,"cap":400,"area":null}"#, &rq).unwrap();
        assert_eq!(ans.len(), 4 * (2 + 6));
        assert!(call_bytes(b"bytes.scrTrack", br#"{"vw":1080,"vh":2400,"keepMisses":1,"keepOff":true,"cap":400,"area":[1,2]}"#, &rq).is_err());
        // A media playlist in UTF-16LE.
        let text: Vec<u8> = "#EXTM3U\n#EXTINF:4,\np.ts\n#EXT-X-ENDLIST\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let pl = call_bytes(b"bytes.hlsMedia", br#"{"base":"http://h/a/m.m3u8"}"#, &text).unwrap();
        assert_eq!(&pl[..4], &0i32.to_le_bytes());
        assert!(call_bytes(b"bytes.hlsMedia", br#"{"base":"nope"}"#, &text).is_err());
        assert!(call_bytes(b"bytes.hlsVariants", br#"{"base":"http://h/"}"#, &text).is_ok());
    }
}
