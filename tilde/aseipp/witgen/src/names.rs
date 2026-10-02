// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! WIT identifiers are kebab-case, `%`-escaped where they would be WIT
//! keywords; each backend recases them for its language and escapes its own
//! keywords.

/// The words of a WIT identifier: `fill-rect` is `fill` and `rect`.
fn words(name: &str) -> impl Iterator<Item = &str> {
    name.trim_start_matches('%')
        .split(['-', '_', '.'])
        .filter(|part| !part.is_empty())
}

/// `fill-rect` to `FillRect`, `%list` to `List`.
pub fn pascal(name: &str) -> String {
    words(name)
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// `dt-ms` to `dtMs`.
pub fn camel(name: &str) -> String {
    let pascal = pascal(name);
    let mut chars = pascal.chars();
    match chars.next() {
        Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

/// `fill-rect` to `fill_rect`.
pub fn snake(name: &str) -> String {
    words(name)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join("_")
}

/// `fill-rect` to `FILL_RECT`.
pub fn shouty(name: &str) -> String {
    snake(name).to_ascii_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cases() {
        assert_eq!(pascal("fill-rect"), "FillRect");
        assert_eq!(pascal("%list"), "List");
        assert_eq!(pascal("kp-enter"), "KpEnter");
        assert_eq!(camel("dt-ms"), "dtMs");
        assert_eq!(camel("x"), "x");
        assert_eq!(snake("present-indexed"), "present_indexed");
        assert_eq!(snake("%type"), "type");
        assert_eq!(shouty("key-releases"), "KEY_RELEASES");
    }
}
