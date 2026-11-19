// SPDX-License-Identifier: GPL-3.0-or-later
// Kurokawa Tools — device battery (kt-battery): a small JSON writer for the command-line output.
// Written here (no crate). Reference: the original v1.1.0's src/json_output.h (JsonEscape) — what it escapes (the quote,
// the backslash, \n \r \t, other control characters as \u00xx) is kept; changed: \b and \f too, the DEL character,
// U+2028 / U+2029 (they end a line in some readers), and an «ASCII only» mode that writes every other non-ASCII
// character as \uXXXX (a surrogate pair above U+FFFF) for a Windows console that would read raw UTF-8 as its own
// code page. Fields come out in the order they were given: the order is part of the format.
// Copyright (C) 2026 Kurokawa contributors. Std only.

/// A JSON value. Object fields keep the order they were pushed in.
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(&'static str, J)>),
}

/// The text of a string's body (no quotes) as JSON writes it. `ascii`: also every non-ASCII character as \uXXXX.
pub fn escape(s: &str, ascii: bool) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            '\u{8}' => o.push_str("\\b"),
            '\u{c}' => o.push_str("\\f"),
            c if (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}' => o.push_str(&format!("\\u{:04x}", c as u32)),
            c if ascii && !c.is_ascii() => {
                let mut b = [0u16; 2];
                for u in c.encode_utf16(&mut b) {
                    o.push_str(&format!("\\u{:04x}", u));
                }
            }
            c => o.push(c),
        }
    }
    o
}

impl J {
    pub fn str(s: &str) -> J {
        J::Str(s.to_string())
    }

    /// The document as text: two spaces of indent, one field or item per line, a newline at the end.
    pub fn render(&self, ascii: bool) -> String {
        let mut o = String::new();
        self.write(&mut o, 0, ascii);
        o.push('\n');
        o
    }

    fn write(&self, o: &mut String, depth: usize, ascii: bool) {
        let pad = |o: &mut String, d: usize| {
            for _ in 0..d {
                o.push_str("  ");
            }
        };
        match self {
            J::Null => o.push_str("null"),
            J::Bool(b) => o.push_str(if *b { "true" } else { "false" }),
            J::Int(n) => o.push_str(&n.to_string()),
            J::Str(s) => {
                o.push('"');
                o.push_str(&escape(s, ascii));
                o.push('"');
            }
            J::Arr(v) if v.is_empty() => o.push_str("[]"),
            J::Arr(v) => {
                o.push_str("[\n");
                for (i, x) in v.iter().enumerate() {
                    pad(o, depth + 1);
                    x.write(o, depth + 1, ascii);
                    o.push_str(if i + 1 < v.len() { ",\n" } else { "\n" });
                }
                pad(o, depth);
                o.push(']');
            }
            J::Obj(v) if v.is_empty() => o.push_str("{}"),
            J::Obj(v) => {
                o.push_str("{\n");
                for (i, (k, x)) in v.iter().enumerate() {
                    pad(o, depth + 1);
                    o.push('"');
                    o.push_str(&escape(k, ascii));
                    o.push_str("\": ");
                    x.write(o, depth + 1, ascii);
                    o.push_str(if i + 1 < v.len() { ",\n" } else { "\n" });
                }
                pad(o, depth);
                o.push('}');
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_json_requires_and_a_little_more() {
        assert_eq!(escape("a\"b\\c", false), "a\\\"b\\\\c");
        assert_eq!(escape("l1\nl2\r\t", false), "l1\\nl2\\r\\t");
        assert_eq!(escape("\u{1}\u{8}\u{c}\u{1f}\u{7f}", false), "\\u0001\\b\\f\\u001f\\u007f");
        assert_eq!(escape("a\u{2028}b\u{2029}", false), "a\\u2028b\\u2029");
        assert_eq!(escape("</script>", false), "</script>", "a slash needs no escape");
    }

    #[test]
    fn non_ascii_names_pass_through_or_are_escaped_on_request() {
        let name = "ماوس \u{30de}\u{30a6}\u{30b9} 鼠标 😀";
        assert_eq!(escape(name, false), name);
        let e = escape(name, true);
        assert!(e.is_ascii());
        assert!(e.contains("\\u0645"), "Arabic mim");
        assert!(e.contains("\\ud83d\\ude00"), "an emoji as a surrogate pair");
    }

    #[test]
    fn fields_keep_their_order_and_the_document_is_stable() {
        let doc = J::Obj(vec![("format", J::Int(1)), ("zeta", J::Bool(true)), ("alpha", J::Null), ("list", J::Arr(vec![J::Int(-3), J::str("x\"y")])), ("none", J::Arr(vec![])), ("o", J::Obj(vec![]))]);
        let want = "{\n  \"format\": 1,\n  \"zeta\": true,\n  \"alpha\": null,\n  \"list\": [\n    -3,\n    \"x\\\"y\"\n  ],\n  \"none\": [],\n  \"o\": {}\n}\n";
        assert_eq!(doc.render(false), want);
        assert_eq!(doc.render(false), doc.render(false));
    }
}
