// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Compact renderings of counts, rates, and times for a status screen.

use std::borrow::Cow;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// `999`, `12.3k`, `1.2M`, `3.4G`.
pub fn count(n: u64) -> String {
    const UNITS: [(u64, char); 3] = [(1_000_000_000, 'G'), (1_000_000, 'M'), (1_000, 'k')];
    for (scale, suffix) in UNITS {
        if n >= scale {
            let value = n as f64 / scale as f64;
            return if value >= 100.0 {
                format!("{value:.0}{suffix}")
            } else {
                format!("{value:.1}{suffix}")
            };
        }
    }
    n.to_string()
}

/// `1,204`.
pub fn count_exact(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index != 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `0.4/s`, `123/s`, `4.1k/s`.
pub fn rate(per_second: f64) -> String {
    if !per_second.is_finite() || per_second <= 0.0 {
        return "0/s".into();
    }
    if per_second < 10.0 {
        format!("{per_second:.1}/s")
    } else if per_second < 1000.0 {
        format!("{per_second:.0}/s")
    } else {
        format!("{}/s", count(per_second.round() as u64))
    }
}

/// `59s`, `1m02s`, `1h02m`, `2d03h`.
pub fn duration(ms: u64) -> String {
    let seconds = ms / 1000;
    let (minutes, seconds) = (seconds / 60, seconds % 60);
    let (hours, minutes) = (minutes / 60, minutes % 60);
    let (days, hours) = (hours / 24, hours % 24);
    if days > 0 {
        format!("{days}d{hours:02}h")
    } else if hours > 0 {
        format!("{hours}h{minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m{seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

/// `never` or `12s ago`.
pub fn age(age_ms: Option<u64>) -> String {
    match age_ms {
        None => "never".into(),
        Some(ms) => format!("{} ago", duration(ms)),
    }
}

pub fn percent(ratio: f64) -> String {
    format!("{:.1}%", ratio * 100.0)
}

/// The UTC time of day, `12:34:56Z`.
pub fn clock(now_ms: u64) -> String {
    let seconds = (now_ms / 1000) % 86_400;
    format!(
        "{:02}:{:02}:{:02}Z",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

/// Cuts `text` to `max_width` terminal columns, ending in `…` when it had
/// to; measured in display width, so wide characters count double.
pub fn truncate(text: &str, max_width: usize) -> Cow<'_, str> {
    if text.width() <= max_width {
        return Cow::Borrowed(text);
    }
    if max_width == 0 {
        return Cow::Borrowed("");
    }
    let mut out = String::new();
    let mut width = 0;
    for character in text.chars() {
        let character_width = character.width().unwrap_or(0);
        if width + character_width > max_width - 1 {
            break;
        }
        width += character_width;
        out.push(character);
    }
    out.push('…');
    Cow::Owned(out)
}

/// The last `lines` lines of `text`, in order.
pub fn tail(text: &str, lines: usize) -> Vec<&str> {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_scale_by_thousands() {
        assert_eq!(count(0), "0");
        assert_eq!(count(999), "999");
        assert_eq!(count(1000), "1.0k");
        assert_eq!(count(12_345), "12.3k");
        assert_eq!(count(999_999), "1000k");
        assert_eq!(count(1_000_000), "1.0M");
        assert_eq!(count(123_456_789), "123M");
        assert_eq!(count(u64::MAX), "18446744074G");
        assert_eq!(count_exact(0), "0");
        assert_eq!(count_exact(999), "999");
        assert_eq!(count_exact(1204), "1,204");
        assert_eq!(count_exact(1_234_567), "1,234,567");
    }

    #[test]
    fn rates_keep_one_decimal_below_ten() {
        assert_eq!(rate(0.0), "0/s");
        assert_eq!(rate(f64::NAN), "0/s");
        assert_eq!(rate(0.44), "0.4/s");
        assert_eq!(rate(999.4), "999/s");
        assert_eq!(rate(4_100.0), "4.1k/s");
    }

    #[test]
    fn durations_show_two_units() {
        assert_eq!(duration(0), "0s");
        assert_eq!(duration(59_999), "59s");
        assert_eq!(duration(60_000), "1m00s");
        assert_eq!(duration(62_000), "1m02s");
        assert_eq!(duration(3_599_999), "59m59s");
        assert_eq!(duration(3_600_000), "1h00m");
        assert_eq!(duration(3_720_000), "1h02m");
        assert_eq!(duration(90_000_000), "1d01h");
        assert_eq!(age(None), "never");
        assert_eq!(age(Some(12_000)), "12s ago");
    }

    #[test]
    fn clock_and_percent_format_plainly() {
        assert_eq!(clock(0), "00:00:00Z");
        assert_eq!(clock(86_399_000), "23:59:59Z");
        assert_eq!(clock(1_700_000_000_000), "22:13:20Z");
        assert_eq!(percent(0.124), "12.4%");
    }

    #[test]
    fn truncation_measures_display_width() {
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(truncate("abcdef", 4), "abc…");
        assert_eq!(truncate("日本語", 6), "日本語");
        assert_eq!(truncate("日本語", 5), "日本…");
        assert_eq!(truncate("abc", 0), "");
        assert_eq!(truncate("abc", 1), "…");
        assert_eq!(tail("a\nb\nc\n", 2), ["b", "c"]);
        assert_eq!(tail("a", 5), ["a"]);
        assert!(tail("", 5).is_empty());
    }
}
