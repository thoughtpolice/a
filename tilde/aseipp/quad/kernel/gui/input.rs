// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Input as the editor takes it: key names, modifiers, and the text an
//! input method is composing, drawn as cells.

use super::*;

/// Shift and alt, as (quad event) has them; the other modifiers are ctrl
/// (4) and super (8).
pub(super) const SHIFT: u32 = 1;
pub(super) const ALT: u32 = 2;

/// Text an input method is composing, drawn over the cells from `cursor`
/// on as a terminal would show it: underlined, in `foreground` on
/// `background`. Returns rectangles (its background), cells (as font/
/// reads them) and their text.
pub(super) fn preedit_cells(
    preedit: &str,
    (row, col): (u32, u32),
    foreground: u32,
    background: u32,
) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    use unicode_width::UnicodeWidthChar;
    let (mut rects, mut cells, mut text) = (Vec::new(), Vec::new(), Vec::new());
    let mut at = col;
    for c in preedit.chars() {
        let width = c.width().unwrap_or(0) as u32;
        if width == 0 {
            continue;
        }
        let start = text.len() as u32;
        let mut buf = [0; 4];
        text.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        // Underlined (4).
        for v in [
            row << 16 | at,
            width << 16 | 4,
            0xff00_0000 | foreground,
            background,
            0,
            start,
            c.len_utf8() as u32,
        ] {
            cells.extend_from_slice(&v.to_ne_bytes());
        }
        at += width;
    }
    for v in [col as f32, row as f32, (at - col) as f32, 1.0] {
        rects.extend_from_slice(&v.to_ne_bytes());
    }
    for v in [0xff00_0000 | background, 0, 0, 0] {
        rects.extend_from_slice(&v.to_ne_bytes());
    }
    (rects, cells, text)
}

/// The name keymaps give a key (core/term.sls names them the same), or
/// None for keys the editor does not take (modifiers on their own).
pub(super) fn key_name(key: NamedKey) -> Option<&'static str> {
    Some(match key {
        NamedKey::Enter => "enter",
        NamedKey::Escape => "esc",
        NamedKey::Tab => "tab",
        NamedKey::Backspace => "backspace",
        NamedKey::Delete => "delete",
        NamedKey::Insert => "insert",
        NamedKey::ArrowLeft => "left",
        NamedKey::ArrowRight => "right",
        NamedKey::ArrowUp => "up",
        NamedKey::ArrowDown => "down",
        NamedKey::Home => "home",
        NamedKey::End => "end",
        NamedKey::PageUp => "pageup",
        NamedKey::PageDown => "pagedown",
        NamedKey::F1 => "f1",
        NamedKey::F2 => "f2",
        NamedKey::F3 => "f3",
        NamedKey::F4 => "f4",
        NamedKey::F5 => "f5",
        NamedKey::F6 => "f6",
        NamedKey::F7 => "f7",
        NamedKey::F8 => "f8",
        NamedKey::F9 => "f9",
        NamedKey::F10 => "f10",
        NamedKey::F11 => "f11",
        NamedKey::F12 => "f12",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_being_composed_covers_the_cells_after_the_cursor() {
        let (rects, cells, text) = preedit_cells("にほ", (3, 5), 0x00ffffff, 0x00102030);
        assert_eq!(text, "にほ".as_bytes());
        // Two wide cells, from column 5, underlined.
        let words: Vec<u32> = cells
            .chunks_exact(4)
            .map(|w| u32::from_ne_bytes(w.try_into().unwrap()))
            .collect();
        assert_eq!(
            words[..7],
            [3 << 16 | 5, 2 << 16 | 4, 0xffffffff, 0x102030, 0, 0, 3]
        );
        assert_eq!(words[7..9], [3 << 16 | 7, 2 << 16 | 4]);
        assert_eq!(words[12], 3);
        // One background rectangle over the four columns.
        let bounds: Vec<f32> = rects[..16]
            .chunks_exact(4)
            .map(|w| f32::from_ne_bytes(w.try_into().unwrap()))
            .collect();
        assert_eq!(bounds, [5.0, 3.0, 4.0, 1.0]);
    }
}
