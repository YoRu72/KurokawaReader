// DNS over HTTPS (RFC 8484), the part that needs no crate: the resolvers the apps offer, a query in DNS's wire
// format (RFC 1035), the addresses read out of an answer, and a small cache kept by the answers' time to live.
// net.rs sends the query (POST, application/dns-message) and plugs the answer into its web client through reqwest's
// resolver hook. Std only, checked alone with `rustc --edition 2021 --test doh.rs`.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub const TYPE_A: u16 = 1;
pub const TYPE_AAAA: u16 = 28;

/// The resolvers the settings offer by name (src/sources/http.ts DOH_PROVIDERS; desktop/main.cjs's DOH).
pub const PROVIDERS: [(&str, &str); 4] = [
    ("cloudflare", "https://cloudflare-dns.com/dns-query"),
    ("google", "https://dns.google/dns-query"),
    ("quad9", "https://dns.quad9.net/dns-query"),
    ("adguard", "https://dns.adguard-dns.com/dns-query"),
];

/// A provider as the page names it → the resolver's address, as main.cjs's applyDoh: a name above, or an https://
/// address as it is; and here also an http:// address on this computer (127.0.0.1, localhost, [::1]) — a resolver
/// running locally, and the self-test's. Anything else ('off', '', an unknown name) → None: the system's resolver.
pub fn server_for(provider: &str) -> Option<String> {
    let p = provider.trim();
    for (name, url) in PROVIDERS.iter() {
        if p == *name {
            return Some(url.to_string());
        }
    }
    if p.starts_with("https://") && p.len() > "https://".len() && !p.contains(char::is_whitespace) {
        return Some(p.to_string());
    }
    if let Some(rest) = p.strip_prefix("http://") {
        let host_port = rest.split('/').next().unwrap_or("");
        let host = if host_port.starts_with('[') {
            match host_port.find(']') {
                Some(i) => &host_port[..=i],
                None => return None,
            }
        } else {
            host_port.split(':').next().unwrap_or("")
        };
        if host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost") || host == "[::1]" {
            return Some(p.to_string());
        }
    }
    None
}

/// A query for `name`'s records of `qtype` (A or AAAA): id 0 (RFC 8484 asks for 0, so answers can be cached by
/// HTTP), recursion desired, one question of class IN.
pub fn encode_query(name: &str, qtype: u16) -> Result<Vec<u8>, String> {
    let n = name.trim().trim_end_matches('.');
    if n.is_empty() || n.len() > 253 {
        return Err(format!("not a host name: {}", name));
    }
    let mut out: Vec<u8> = vec![0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
    for label in n.split('.') {
        let b = label.as_bytes();
        if b.is_empty() || b.len() > 63 {
            return Err(format!("not a host name: {}", name));
        }
        out.push(b.len() as u8);
        out.extend_from_slice(b);
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    Ok(out)
}

/// What an answer gave: the addresses of the type asked for (in the order given) and the shortest time to live
/// among them (seconds; 0 when there are none).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub ips: Vec<IpAddr>,
    pub ttl: u32,
}

fn u16_at(m: &[u8], i: usize) -> Result<u16, String> {
    if i + 2 > m.len() {
        return Err("DNS answer cut short".to_string());
    }
    Ok(u16::from_be_bytes([m[i], m[i + 1]]))
}

fn u32_at(m: &[u8], i: usize) -> Result<u32, String> {
    if i + 4 > m.len() {
        return Err("DNS answer cut short".to_string());
    }
    Ok(u32::from_be_bytes([m[i], m[i + 1], m[i + 2], m[i + 3]]))
}

/// The position after the name that starts at `i` (labels, ending in a zero byte or a pointer).
fn skip_name(m: &[u8], mut i: usize) -> Result<usize, String> {
    let mut steps = 0;
    loop {
        steps += 1;
        if i >= m.len() || steps > 128 {
            return Err("DNS answer cut short".to_string());
        }
        let len = m[i] as usize;
        if len == 0 {
            return Ok(i + 1);
        }
        if len & 0xC0 == 0xC0 {
            if i + 2 > m.len() {
                return Err("DNS answer cut short".to_string());
            }
            return Ok(i + 2);
        }
        if len & 0xC0 != 0 {
            return Err("DNS answer: a label of an unknown kind".to_string());
        }
        i += 1 + len;
    }
}

/// The records of `qtype` in an answer. A name the resolver says does not exist, or any other failure it reports, is
/// an error; an answer with no such record (the name has none of that kind) is an empty list.
pub fn decode_answer(m: &[u8], qtype: u16) -> Result<Answer, String> {
    if m.len() < 12 {
        return Err("DNS answer cut short".to_string());
    }
    let flags = u16_at(m, 2)?;
    if flags & 0x8000 == 0 {
        return Err("not a DNS answer".to_string());
    }
    if flags & 0x0200 != 0 {
        return Err("DNS answer truncated".to_string());
    }
    let rcode = flags & 0x000F;
    if rcode == 3 {
        return Err("no such host (the DNS-over-HTTPS resolver says it does not exist)".to_string());
    }
    if rcode != 0 {
        return Err(format!("the DNS-over-HTTPS resolver failed (code {})", rcode));
    }
    let qd = u16_at(m, 4)? as usize;
    let an = u16_at(m, 6)? as usize;
    let mut i = 12;
    for _ in 0..qd {
        i = skip_name(m, i)? + 4;
    }
    let mut ips: Vec<IpAddr> = Vec::new();
    let mut ttl: u32 = u32::MAX;
    for _ in 0..an {
        i = skip_name(m, i)?;
        let t = u16_at(m, i)?;
        let class = u16_at(m, i + 2)?;
        let rttl = u32_at(m, i + 4)?;
        let len = u16_at(m, i + 8)? as usize;
        let at = i + 10;
        if at + len > m.len() {
            return Err("DNS answer cut short".to_string());
        }
        if class == 1 && t == qtype {
            if t == TYPE_A && len == 4 {
                ips.push(IpAddr::V4(Ipv4Addr::new(m[at], m[at + 1], m[at + 2], m[at + 3])));
                ttl = ttl.min(rttl);
            } else if t == TYPE_AAAA && len == 16 {
                let mut b = [0u8; 16];
                b.copy_from_slice(&m[at..at + 16]);
                ips.push(IpAddr::V6(Ipv6Addr::from(b)));
                ttl = ttl.min(rttl);
            }
        }
        i = at + len;
    }
    if ips.is_empty() {
        ttl = 0;
    }
    Ok(Answer { ips, ttl })
}

/// The same query with an id of the caller's (a GET can be cached by id 0; a POST — Tools' chain — gets a random
/// one, so an answer meant for another question is told apart).
pub fn encode_query_id(name: &str, qtype: u16, id: u16) -> Result<Vec<u8>, String> {
    let mut q = encode_query(name, qtype)?;
    q[0..2].copy_from_slice(&id.to_be_bytes());
    Ok(q)
}

/// Why `decode_strict` refused an answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    /// The resolver says the name does not exist (an answer, not a failure: no other resolver is asked).
    NoSuchName,
    /// Anything else: the resolver's failure, or an answer not to be trusted — the next resolver is asked.
    Bad(String),
}

/// A name at `i`, compression pointers followed (only backwards, at most 32 of them, at most 255 bytes): the name
/// (lowercased, dotted) and the position after it where it first ended.
fn read_name(m: &[u8], mut i: usize) -> Result<(String, usize), String> {
    let mut labels: Vec<String> = Vec::new();
    let mut end: Option<usize> = None;
    let mut jumps = 0;
    let mut total = 0usize;
    loop {
        let len = *m.get(i).ok_or("DNS answer cut short")? as usize;
        if len == 0 {
            return Ok((labels.join("."), end.unwrap_or(i + 1)));
        }
        if len & 0xC0 == 0xC0 {
            let to = (((len & 0x3F) << 8) | *m.get(i + 1).ok_or("DNS answer cut short")? as usize) as usize;
            jumps += 1;
            if jumps > 32 || to >= i {
                return Err("DNS answer: a name that points at itself".to_string());
            }
            if end.is_none() {
                end = Some(i + 2);
            }
            i = to;
            continue;
        }
        if len & 0xC0 != 0 {
            return Err("DNS answer: a label of an unknown kind".to_string());
        }
        let l = m.get(i + 1..i + 1 + len).ok_or("DNS answer cut short")?;
        total += len + 1;
        if total > 255 {
            return Err("DNS answer: a name too long".to_string());
        }
        labels.push(String::from_utf8_lossy(l).to_ascii_lowercase());
        i += 1 + len;
    }
}

/// An answer read as Tools' chain wants it, trusting nothing: at most 65535 bytes, an answer (not a question), not
/// truncated, the id and the one question the ones asked; then the records of the name asked, CNAMEs followed (at most
/// 8, a loop refused), only those of class IN and the type asked. «No such name» is NoSuchName; an answer with no
/// record of the type is an empty list (the caller treats it as «no address»).
pub fn decode_strict(m: &[u8], qname: &str, qtype: u16, id: u16) -> Result<Answer, Refused> {
    let bad = |s: &str| Refused::Bad(s.to_string());
    if m.len() > 65535 {
        return Err(bad("DNS answer too big"));
    }
    if m.len() < 12 {
        return Err(bad("DNS answer cut short"));
    }
    if u16::from_be_bytes([m[0], m[1]]) != id {
        return Err(bad("DNS answer for another question (id)"));
    }
    let flags = u16::from_be_bytes([m[2], m[3]]);
    if flags & 0x8000 == 0 {
        return Err(bad("not a DNS answer"));
    }
    if flags & 0x0200 != 0 {
        return Err(bad("DNS answer truncated"));
    }
    match flags & 0x000F {
        0 => {}
        3 => return Err(Refused::NoSuchName),
        rc => return Err(Refused::Bad(format!("the resolver failed (code {})", rc))),
    }
    let qd = u16::from_be_bytes([m[4], m[5]]);
    let an = u16::from_be_bytes([m[6], m[7]]) as usize;
    if qd != 1 {
        return Err(bad("DNS answer for another question"));
    }
    let want = qname.trim_end_matches('.').to_ascii_lowercase();
    let (q, mut i) = read_name(m, 12).map_err(Refused::Bad)?;
    let qt = u16_at(m, i).map_err(Refused::Bad)?;
    if q != want || qt != qtype {
        return Err(bad("DNS answer for another question"));
    }
    i += 4;
    if i > m.len() {
        return Err(bad("DNS answer cut short"));
    }
    // (Every record of the answer section: owner, type, class, TTL, data's place.)
    let mut recs: Vec<(String, u16, u16, u32, usize, usize)> = Vec::new();
    for _ in 0..an {
        let (owner, at) = read_name(m, i).map_err(Refused::Bad)?;
        let t = u16_at(m, at).map_err(Refused::Bad)?;
        let class = u16_at(m, at + 2).map_err(Refused::Bad)?;
        let ttl = u32_at(m, at + 4).map_err(Refused::Bad)?;
        let len = u16_at(m, at + 8).map_err(Refused::Bad)? as usize;
        let data = at + 10;
        if data + len > m.len() {
            return Err(bad("DNS answer cut short"));
        }
        recs.push((owner, t, class, ttl, data, len));
        i = data + len;
    }
    let mut name = want;
    let mut seen: Vec<String> = vec![name.clone()];
    let mut ttl = u32::MAX;
    for _ in 0..=8 {
        let mut ips: Vec<IpAddr> = Vec::new();
        for (owner, t, class, rttl, at, len) in recs.iter() {
            if *owner != name || *class != 1 || *t != qtype {
                continue;
            }
            if *t == TYPE_A && *len == 4 {
                ips.push(IpAddr::V4(Ipv4Addr::new(m[*at], m[at + 1], m[at + 2], m[at + 3])));
            } else if *t == TYPE_AAAA && *len == 16 {
                let mut b = [0u8; 16];
                b.copy_from_slice(&m[*at..at + 16]);
                ips.push(IpAddr::V6(Ipv6Addr::from(b)));
            } else {
                return Err(bad("DNS answer: an address of the wrong size"));
            }
            ttl = ttl.min(*rttl);
        }
        if !ips.is_empty() {
            return Ok(Answer { ips, ttl });
        }
        let cname = recs.iter().find(|(o, t, c, _, _, _)| *o == name && *t == 5 && *c == 1);
        match cname {
            Some((_, _, _, rttl, at, _)) => {
                let (to, _) = read_name(m, *at).map_err(Refused::Bad)?;
                if seen.contains(&to) {
                    return Err(bad("DNS answer: a CNAME loop"));
                }
                ttl = ttl.min(*rttl);
                seen.push(to.clone());
                name = to;
            }
            None => return Ok(Answer { ips: Vec::new(), ttl: 0 }),
        }
    }
    Err(bad("DNS answer: too many CNAMEs"))
}

/// Names answered without asking anyone (as Chromium does): an address written as one, and localhost.
pub fn local_answer(host: &str) -> Option<Vec<IpAddr>> {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return Some(vec![ip]);
    }
    let lower = h.trim_end_matches('.').to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") {
        return Some(vec![
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]);
    }
    None
}

/// Answers kept until their time to live runs out (at least 30 s, at most an hour), per resolver and name; at most
/// MAX of them.
pub struct Cache {
    entries: Vec<(String, String, Vec<IpAddr>, u64)>,
}

const MAX: usize = 512;

impl Cache {
    pub const fn new() -> Cache {
        Cache {
            entries: Vec::new(),
        }
    }

    pub fn get(&self, server: &str, name: &str, now: u64) -> Option<Vec<IpAddr>> {
        let n = name.to_ascii_lowercase();
        self.entries
            .iter()
            .find(|e| e.0 == server && e.1 == n && e.3 > now)
            .map(|e| e.2.clone())
    }

    pub fn put(&mut self, server: &str, name: &str, ips: Vec<IpAddr>, ttl: u32, now: u64) {
        let n = name.to_ascii_lowercase();
        let keep = (ttl as u64).clamp(30, 3600);
        self.entries.retain(|e| e.3 > now && !(e.0 == server && e.1 == n));
        if self.entries.len() >= MAX {
            self.entries.remove(0);
        }
        self.entries.push((server.to_string(), n, ips, now + keep));
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Which of net.rs's four cached clients a request goes through: the resolver chosen or not (`doh_on`), and redirects
/// followed by the client (the app's requests) or left to the caller (the outside players' relay, which follows them
/// hop by hop itself). Every one of them shares the app's cookie jar; the two with DoH use it strictly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientSlot {
    Plain,
    ViaDoh,
    PlainNoRedirect,
    ViaDohNoRedirect,
}

pub fn client_slot(doh_on: bool, follow_redirects: bool) -> ClientSlot {
    match (doh_on, follow_redirects) {
        (false, true) => ClientSlot::Plain,
        (true, true) => ClientSlot::ViaDoh,
        (false, false) => ClientSlot::PlainNoRedirect,
        (true, false) => ClientSlot::ViaDohNoRedirect,
    }
}

/// Whether a slot's client asks the DoH resolver (and never the system's DNS).
pub fn slot_uses_doh(s: ClientSlot) -> bool {
    matches!(s, ClientSlot::ViaDoh | ClientSlot::ViaDohNoRedirect)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_slots() {
        assert_eq!(client_slot(false, true), ClientSlot::Plain);
        assert_eq!(client_slot(true, true), ClientSlot::ViaDoh);
        assert_eq!(client_slot(false, false), ClientSlot::PlainNoRedirect);
        assert_eq!(client_slot(true, false), ClientSlot::ViaDohNoRedirect);
        // the relay's client asks the resolver exactly when the app's does
        for on in [false, true] {
            assert_eq!(slot_uses_doh(client_slot(on, false)), slot_uses_doh(client_slot(on, true)));
            assert_eq!(slot_uses_doh(client_slot(on, false)), on);
            assert_ne!(client_slot(on, false), client_slot(on, true));
        }
    }

    /// An answer as a resolver writes one: the question echoed, then the records (name by pointer to it).
    fn answer(query: &[u8], rcode: u16, records: &[(u16, u32, Vec<u8>)]) -> Vec<u8> {
        let mut m = query.to_vec();
        let flags: u16 = 0x8180 | rcode;
        m[2..4].copy_from_slice(&flags.to_be_bytes());
        m[6..8].copy_from_slice(&(records.len() as u16).to_be_bytes());
        for (t, ttl, data) in records {
            m.extend_from_slice(&[0xC0, 0x0C]);
            m.extend_from_slice(&t.to_be_bytes());
            m.extend_from_slice(&1u16.to_be_bytes());
            m.extend_from_slice(&ttl.to_be_bytes());
            m.extend_from_slice(&(data.len() as u16).to_be_bytes());
            m.extend_from_slice(data);
        }
        m
    }

    #[test]
    fn providers() {
        assert_eq!(server_for("cloudflare").as_deref(), Some("https://cloudflare-dns.com/dns-query"));
        assert_eq!(server_for("adguard").as_deref(), Some("https://dns.adguard-dns.com/dns-query"));
        assert_eq!(server_for("off"), None);
        assert_eq!(server_for(""), None);
        assert_eq!(server_for("nonsense"), None);
        assert_eq!(server_for("https://doh.example/q").as_deref(), Some("https://doh.example/q"));
        assert_eq!(server_for("https://"), None);
        assert_eq!(server_for("http://127.0.0.1:5353/dns-query").as_deref(), Some("http://127.0.0.1:5353/dns-query"));
        assert_eq!(server_for("http://localhost/dns-query").as_deref(), Some("http://localhost/dns-query"));
        assert_eq!(server_for("http://[::1]:8053/q").as_deref(), Some("http://[::1]:8053/q"));
        assert_eq!(server_for("http://doh.example/q"), None);
        assert_eq!(server_for("http://127.0.0.1.evil.example/q"), None);
    }

    #[test]
    fn query_bytes() {
        let q = encode_query("ab.c.", TYPE_A).unwrap();
        assert_eq!(q, vec![0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, b'a', b'b', 1, b'c', 0, 0, 1, 0, 1]);
        let q6 = encode_query("x.y", TYPE_AAAA).unwrap();
        assert_eq!(&q6[q6.len() - 4..], &[0, 28, 0, 1]);
        assert!(encode_query("", TYPE_A).is_err());
        assert!(encode_query("a..b", TYPE_A).is_err());
        assert!(encode_query(&"a".repeat(64), TYPE_A).is_err());
    }

    #[test]
    fn answers() {
        let q = encode_query("kr.test", TYPE_A).unwrap();
        // (A CNAME first, as resolvers send the chain; then two addresses.)
        let a = answer(&q, 0, &[(5, 300, vec![2, b'k', b'r', 0]), (1, 120, vec![127, 0, 0, 1]), (1, 60, vec![10, 0, 0, 2])]);
        let r = decode_answer(&a, TYPE_A).unwrap();
        assert_eq!(r.ips, vec!["127.0.0.1".parse::<IpAddr>().unwrap(), "10.0.0.2".parse::<IpAddr>().unwrap()]);
        assert_eq!(r.ttl, 60);
        let q6 = encode_query("kr.test", TYPE_AAAA).unwrap();
        let mut v6 = vec![0u8; 16];
        v6[15] = 1;
        let r6 = decode_answer(&answer(&q6, 0, &[(28, 30, v6)]), TYPE_AAAA).unwrap();
        assert_eq!(r6.ips, vec!["::1".parse::<IpAddr>().unwrap()]);
        // (No record of the kind: an empty list, not an error.)
        assert_eq!(decode_answer(&answer(&q6, 0, &[]), TYPE_AAAA).unwrap(), Answer { ips: vec![], ttl: 0 });
        // (A records in an AAAA answer are not taken.)
        assert!(decode_answer(&answer(&q6, 0, &[(1, 5, vec![1, 2, 3, 4])]), TYPE_AAAA).unwrap().ips.is_empty());
        let nx = decode_answer(&answer(&q, 3, &[]), TYPE_A).unwrap_err();
        assert!(nx.contains("does not exist"), "{}", nx);
        assert!(decode_answer(&answer(&q, 2, &[]), TYPE_A).unwrap_err().contains("code 2"));
        assert!(decode_answer(&q, TYPE_A).unwrap_err().contains("not a DNS answer"));
        let mut cut = answer(&q, 0, &[(1, 5, vec![1, 2, 3, 4])]);
        cut.truncate(cut.len() - 2);
        assert!(decode_answer(&cut, TYPE_A).is_err());
        assert!(decode_answer(&[0x80], TYPE_A).is_err());
    }

    /// An answer with the question echoed (id `id`) and records given whole: (owner as wire bytes, type, ttl, data).
    fn raw(id: u16, flags: u16, q: &[u8], recs: &[(Vec<u8>, u16, u32, Vec<u8>)]) -> Vec<u8> {
        let mut m = q.to_vec();
        m[0..2].copy_from_slice(&id.to_be_bytes());
        m[2..4].copy_from_slice(&flags.to_be_bytes());
        m[6..8].copy_from_slice(&(recs.len() as u16).to_be_bytes());
        for (owner, t, ttl, data) in recs {
            m.extend_from_slice(owner);
            m.extend_from_slice(&t.to_be_bytes());
            m.extend_from_slice(&1u16.to_be_bytes());
            m.extend_from_slice(&ttl.to_be_bytes());
            m.extend_from_slice(&(data.len() as u16).to_be_bytes());
            m.extend_from_slice(data);
        }
        m
    }

    fn wire(name: &str) -> Vec<u8> {
        let mut v = Vec::new();
        for l in name.split('.') {
            v.push(l.len() as u8);
            v.extend_from_slice(l.as_bytes());
        }
        v.push(0);
        v
    }

    #[test]
    fn strict_answers() {
        let id = 0x5a17;
        let q = encode_query_id("Site.Test", TYPE_A, id).unwrap();
        assert_eq!(&q[0..2], &[0x5a, 0x17]);
        let ptr = vec![0xC0, 0x0C];
        // A plain answer, the owner by pointer to the question.
        let ok = raw(id, 0x8180, &q, &[(ptr.clone(), 1, 90, vec![203, 0, 113, 5]), (ptr.clone(), 1, 40, vec![203, 0, 113, 6])]);
        assert_eq!(decode_strict(&ok, "site.test", TYPE_A, id).unwrap(), Answer { ips: vec!["203.0.113.5".parse().unwrap(), "203.0.113.6".parse().unwrap()], ttl: 40 });
        // A CNAME chain followed; a record for an unrelated name ignored.
        let chain = raw(id, 0x8180, &q, &[(ptr.clone(), 5, 300, wire("cdn.test")), (wire("other.test"), 1, 5, vec![198, 51, 100, 1]), (wire("cdn.test"), 1, 60, vec![198, 51, 100, 2])]);
        assert_eq!(decode_strict(&chain, "site.test", TYPE_A, id).unwrap(), Answer { ips: vec!["198.51.100.2".parse().unwrap()], ttl: 60 });
        // A CNAME loop.
        let looped = raw(id, 0x8180, &q, &[(ptr.clone(), 5, 300, wire("b.test")), (wire("b.test"), 5, 300, wire("site.test"))]);
        assert!(matches!(decode_strict(&looped, "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("loop")));
        // Too many CNAMEs.
        let mut many = vec![(ptr.clone(), 5u16, 300u32, wire("c0.test"))];
        for k in 0..10 {
            many.push((wire(&format!("c{}.test", k)), 5, 300, wire(&format!("c{}.test", k + 1))));
        }
        assert!(matches!(decode_strict(&raw(id, 0x8180, &q, &many), "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("too many")));
        // The wrong id, truncated, not an answer, another question, a server failure, no such name.
        assert!(matches!(decode_strict(&ok, "site.test", TYPE_A, id + 1), Err(Refused::Bad(e)) if e.contains("id")));
        assert!(matches!(decode_strict(&raw(id, 0x8380, &q, &[]), "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("truncated")));
        assert!(matches!(decode_strict(&raw(id, 0x0100, &q, &[]), "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("not a DNS answer")));
        assert!(matches!(decode_strict(&ok, "other.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("another question")));
        assert!(matches!(decode_strict(&ok, "site.test", TYPE_AAAA, id), Err(Refused::Bad(e)) if e.contains("another question")));
        assert!(matches!(decode_strict(&raw(id, 0x8182, &q, &[]), "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("code 2")));
        assert_eq!(decode_strict(&raw(id, 0x8183, &q, &[]), "site.test", TYPE_A, id), Err(Refused::NoSuchName));
        // Cut short, oversized, an address of the wrong size, a pointer to itself.
        let mut cut = ok.clone();
        cut.truncate(cut.len() - 1);
        assert!(decode_strict(&cut, "site.test", TYPE_A, id).is_err());
        let mut big = ok.clone();
        big.resize(70000, 0);
        assert!(matches!(decode_strict(&big, "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("too big")));
        assert!(matches!(decode_strict(&raw(id, 0x8180, &q, &[(ptr.clone(), 1, 9, vec![1, 2, 3])]), "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("wrong size")));
        let self_ptr = raw(id, 0x8180, &q, &[(vec![0xC0, (q.len()) as u8], 1, 9, vec![1, 2, 3, 4])]);
        assert!(matches!(decode_strict(&self_ptr, "site.test", TYPE_A, id), Err(Refused::Bad(e)) if e.contains("points at itself")));
        // No record of the type: an empty list.
        assert_eq!(decode_strict(&raw(id, 0x8180, &q, &[]), "site.test", TYPE_A, id).unwrap().ips.len(), 0);
    }

    /// The shared wire vectors (Tools' core/kt-core/src/doh-cases.txt «wire» lines): the same answers through this
    /// decoder, KrDoh.parseStrict and dohchain.cjs decodeStrict.
    #[test]
    fn shared_wire_vectors() {
        let text = include_str!("../../../apps/tools/core/kt-core/src/doh-cases.txt");
        let mut n = 0;
        for line in text.lines().filter(|l| l.starts_with("wire|")) {
            let f: Vec<&str> = line.split('|').collect();
            let (what, qname, qtype, id, hex, want) = (f[1], f[2], f[3].parse::<u16>().unwrap(), f[4].parse::<u16>().unwrap(), f[5], f[6]);
            let m: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
            let got = match decode_strict(&m, qname, qtype, id) {
                Ok(a) => format!("ok:{}:{}", a.ips.iter().map(|ip| ip.to_string()).collect::<Vec<_>>().join(","), a.ttl),
                Err(Refused::NoSuchName) => "err:nx".to_string(),
                Err(Refused::Bad(e)) => format!("err:{}", kind_of(&e)),
            };
            assert_eq!(got, want, "wire {}", what);
            n += 1;
        }
        assert!(n >= 15, "{}", n);
    }

    fn kind_of(e: &str) -> &'static str {
        for (k, s) in [("id", "(id)"), ("question", "another question"), ("trunc", "truncated"), ("notanswer", "not a DNS answer"), ("server", "(code"), ("loop", "loop"), ("toomany", "too many"), ("short", "cut short"), ("pointer", "points at itself"), ("size", "wrong size")] {
            if e.contains(s) {
                return k;
            }
        }
        "other"
    }

    #[test]
    fn local_names() {
        assert_eq!(local_answer("127.0.0.1").unwrap(), vec!["127.0.0.1".parse::<IpAddr>().unwrap()]);
        assert_eq!(local_answer("[::1]").unwrap(), vec!["::1".parse::<IpAddr>().unwrap()]);
        assert_eq!(local_answer("LocalHost").unwrap().len(), 2);
        assert!(local_answer("example.com").is_none());
    }

    #[test]
    fn cache() {
        let mut c = Cache::new();
        let ip: IpAddr = "1.2.3.4".parse().unwrap();
        c.put("s", "Ex.com", vec![ip], 5, 1000);
        assert_eq!(c.get("s", "ex.com", 1029), Some(vec![ip]));
        assert_eq!(c.get("s", "ex.com", 1030), None);
        assert_eq!(c.get("other", "ex.com", 1001), None);
        c.put("s", "ex.com", vec![ip], 99999, 1000);
        assert_eq!(c.len(), 1);
        assert!(c.get("s", "ex.com", 1000 + 3599).is_some() && c.get("s", "ex.com", 1000 + 3600).is_none());
        for i in 0..600 {
            c.put("s", &format!("n{}", i), vec![ip], 60, 1000);
        }
        assert!(c.len() <= MAX);
        c.clear();
        assert_eq!(c.len(), 0);
    }
}
