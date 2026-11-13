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

#[cfg(test)]
mod tests {
    use super::*;

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
