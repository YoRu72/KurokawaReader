// The DNS-over-HTTPS resolvers Tools' settings offer by name (desktop/main.cjs's DOH table; src/views/settings.ts's
// list), for the Tauri shell's kt:setDoh: a name → the resolver's address, which the shared crate's net::set_doh puts
// in force for the app's own requests. «auto» — Electron hands Chromium every resolver of the table — is the first
// one here (the shared resolver asks one at a time); «off», '' and an unknown name are the system's DNS; an https://
// address is taken as it is, and an http:// one only on this computer (a resolver running locally; the self-test's),
// as the shared crate's doh::server_for. Std only, checked alone: `rustc --edition 2021 --test dohnames.rs`.

/// main.cjs's DOH, in its order.
pub const TABLE: [(&str, &str); 8] = [
    ("cloudflare", "https://cloudflare-dns.com/dns-query"),
    ("google", "https://dns.google/dns-query"),
    ("quad9", "https://dns.quad9.net/dns-query"),
    ("adguard", "https://dns.adguard-dns.com/dns-query"),
    ("mullvad", "https://dns.mullvad.net/dns-query"),
    ("dnssb", "https://doh.dns.sb/dns-query"),
    ("controld", "https://freedns.controld.com/p0"),
    ("opendns", "https://doh.opendns.com/dns-query"),
];

/// The resolver for a provider as the page names it → what net::set_doh is given: an https:// address, or «off».
pub fn resolver_for(provider: &str) -> String {
    let p = provider.trim();
    if p == "auto" {
        return TABLE[0].1.to_string();
    }
    for (name, url) in TABLE.iter() {
        if p == *name {
            return url.to_string();
        }
    }
    if p.starts_with("https://") && p.len() > "https://".len() && !p.contains(char::is_whitespace) {
        return p.to_string();
    }
    if let Some(rest) = p.strip_prefix("http://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = if let Some(h) = host.strip_prefix('[') { h.split(']').next().unwrap_or("") } else { host.split(':').next().unwrap_or("") };
        if (host == "127.0.0.1" || host == "localhost" || host == "::1") && !p.contains(char::is_whitespace) {
            return p.to_string();
        }
    }
    "off".to_string()
}

/// What the probe names as the resolver asked: the address without its query.
pub fn probe_label(resolver: &str) -> String {
    if resolver == "off" {
        "system DNS".to_string()
    } else {
        resolver.split('?').next().unwrap_or(resolver).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(resolver_for("cloudflare"), "https://cloudflare-dns.com/dns-query");
        assert_eq!(resolver_for("controld"), "https://freedns.controld.com/p0");
        assert_eq!(resolver_for(" opendns "), "https://doh.opendns.com/dns-query");
        assert_eq!(resolver_for("auto"), TABLE[0].1);
        assert_eq!(resolver_for("https://my.example/dns-query"), "https://my.example/dns-query");
        assert_eq!(resolver_for("http://evil.example/dns"), "off");
        assert_eq!(resolver_for("http://127.0.0.1.evil.example/dns"), "off");
        assert_eq!(resolver_for("http://127.0.0.1:4567/dns-query"), "http://127.0.0.1:4567/dns-query");
        assert_eq!(resolver_for("http://[::1]:80/dns-query"), "http://[::1]:80/dns-query");
        assert_eq!(resolver_for("https://a b"), "off");
        assert_eq!(resolver_for("off"), "off");
        assert_eq!(resolver_for(""), "off");
        assert_eq!(resolver_for("nonesuch"), "off");
        assert_eq!(probe_label("off"), "system DNS");
        assert_eq!(probe_label("https://x/dns-query?a=1"), "https://x/dns-query");
    }
}
