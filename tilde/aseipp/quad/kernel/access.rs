// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What a window shows, for screen readers: an AccessKit tree, which its
//! winit adapter gives the desktop's accessibility bus (AT-SPI, on Linux),
//! once something there asks for it.
//!
//! The window holds a terminal (AccessKit's role for one), whose text is a
//! run for each row of cells, laid out where the row is, with the text
//! cursor as its selection: a screen reader reads the screen as it reads a
//! terminal's, by line, word and character, and follows the cursor. Each
//! frame updates the rows it changed; until something asks for the tree,
//! nothing is built.

use accesskit::{
    Node, NodeId, Rect, Role, TextDirection, TextPosition, TextSelection, TreeId, TreeInfo,
    TreeUpdate,
};
use accesskit_winit::Adapter;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, EventLoopProxy};
use winit::window::Window;

const WINDOW: NodeId = NodeId(0);
const TERMINAL: NodeId = NodeId(1);

fn row_id(row: usize) -> NodeId {
    NodeId(2 + row as u64)
}

/// A row's characters, as the editor put them in cells: each one's column,
/// width in cells, and text (a character and the marks on it).
pub type RowChars = Vec<(u32, u32, String)>;

/// What the tree shows: the screen's rows, where they are, and the cursor.
pub struct View {
    pub title: String,
    pub rows: Vec<RowChars>,
    pub cols: u32,
    /// A cell's size, and where the grid's top left is, in pixels.
    pub cell: [f32; 2],
    pub origin: f32,
    /// (row, column).
    pub cursor: Option<(u32, u32)>,
}

pub struct Access {
    adapter: Adapter,
    /// How many rows the tree has, as last sent.
    rows: usize,
}

impl Access {
    /// The adapter for `window`, which must not have been shown yet; its
    /// requests come to the event loop through `proxy`.
    pub fn new<T: From<accesskit_winit::Event> + Send + 'static>(
        event_loop: &ActiveEventLoop,
        window: &Window,
        proxy: EventLoopProxy<T>,
    ) -> Access {
        Access {
            adapter: Adapter::with_event_loop_proxy(event_loop, window, proxy),
            rows: 0,
        }
    }

    /// Each of the window's events, before the window takes it.
    pub fn process_event(&mut self, window: &Window, event: &WindowEvent) {
        self.adapter.process_event(window, event);
    }

    /// The whole tree, as asked for, or after what changed all of it.
    /// `view` is made only where something reads the tree.
    pub fn whole(&mut self, view: impl FnOnce() -> View) {
        let rows = &mut self.rows;
        self.adapter.update_if_active(|| {
            let view = view();
            *rows = view.rows.len();
            whole_tree(&view)
        });
    }

    /// The rows marked in `changed`, and the cursor, of a screen of `rows`
    /// rows; `view` is made only where something reads the tree.
    pub fn changed(&mut self, rows: usize, changed: &[bool], view: impl FnOnce() -> View) {
        if rows != self.rows {
            self.whole(view);
            return;
        }
        self.adapter
            .update_if_active(|| changed_rows(&view(), changed));
    }
}

/// The tree: the window, its terminal, and the terminal's rows.
pub fn whole_tree(view: &View) -> TreeUpdate {
    let mut window = Node::new(Role::Window);
    window.set_label(view.title.as_str());
    window.set_children(vec![TERMINAL]);
    let mut nodes = vec![(WINDOW, window), (TERMINAL, terminal(view))];
    nodes.extend((0..view.rows.len()).map(|r| (row_id(r), row(view, r))));
    let mut tree = TreeInfo::new(WINDOW);
    tree.toolkit_name = Some("quad".into());
    TreeUpdate {
        nodes,
        tree: Some(tree),
        tree_id: TreeId::ROOT,
        focus: TERMINAL,
    }
}

/// An update of the rows marked in `changed` (and the terminal, whose
/// cursor may have moved).
pub fn changed_rows(view: &View, changed: &[bool]) -> TreeUpdate {
    let mut nodes = vec![(TERMINAL, terminal(view))];
    for (r, _) in changed.iter().enumerate().filter(|(_, c)| **c) {
        if r < view.rows.len() {
            nodes.push((row_id(r), row(view, r)));
        }
    }
    TreeUpdate {
        nodes,
        tree: None,
        tree_id: TreeId::ROOT,
        focus: TERMINAL,
    }
}

fn terminal(view: &View) -> Node {
    let mut node = Node::new(Role::Terminal);
    node.set_children((0..view.rows.len()).map(row_id).collect::<Vec<_>>());
    let [cw, ch] = view.cell;
    node.set_bounds(Rect {
        x0: f64::from(view.origin),
        y0: f64::from(view.origin),
        x1: f64::from(view.origin + view.cols as f32 * cw),
        y1: f64::from(view.origin + view.rows.len() as f32 * ch),
    });
    if let Some((r, c)) = view.cursor.filter(|&(r, _)| (r as usize) < view.rows.len()) {
        let at = TextPosition {
            node: row_id(r as usize),
            character_index: character_at(&view.rows[r as usize], c),
        };
        node.set_text_selection(TextSelection {
            anchor: at,
            focus: at,
        });
    }
    node
}

/// The index of the character in `chars` (as [`row`] lays them out, with
/// blanks between) that column `col` is in.
fn character_at(chars: &RowChars, col: u32) -> usize {
    let mut index = 0;
    let mut at = 0;
    for (c, w, _) in chars {
        if col < *c {
            return index + (col - at) as usize;
        }
        index += (c - at) as usize;
        if col < c + w {
            return index;
        }
        index += 1;
        at = c + w;
    }
    index + (col - at) as usize
}

/// Row `r`'s text run: its characters, blanks where no character is, each
/// where its cells are, and a newline at the end of all but the last, as
/// the lines of a text are.
fn row(view: &View, r: usize) -> Node {
    let [cw, ch] = view.cell;
    let mut text = String::new();
    let mut lengths = Vec::new();
    let mut positions = Vec::new();
    let mut widths = Vec::new();
    let mut word_starts = Vec::new();
    let mut push = |s: &str, col: u32, width: u32| {
        let blank = s.trim().is_empty();
        let after_blank = text.chars().last().is_none_or(char::is_whitespace);
        if !blank && after_blank && lengths.len() < 256 {
            word_starts.push(lengths.len() as u8);
        }
        text.push_str(s);
        lengths.push(s.len().min(255) as u8);
        positions.push(col as f32 * cw);
        widths.push(width as f32 * cw);
    };
    let mut col = 0;
    for (c, w, s) in &view.rows[r] {
        while col < *c {
            push(" ", col, 1);
            col += 1;
        }
        push(s, *c, *w);
        col = c + w;
    }
    // Blanks up to the cursor, so that it has a character to be at.
    if let Some((_, cc)) = view.cursor.filter(|&(cr, _)| cr as usize == r) {
        while col <= cc {
            push(" ", col, 1);
            col += 1;
        }
    }
    if r + 1 < view.rows.len() {
        push("\n", col, 0);
    }
    let mut node = Node::new(Role::TextRun);
    node.set_value(text);
    node.set_character_lengths(lengths);
    node.set_character_positions(positions);
    node.set_character_widths(widths);
    node.set_word_starts(word_starts);
    node.set_text_direction(TextDirection::LeftToRight);
    let y = view.origin + r as f32 * ch;
    node.set_bounds(Rect {
        x0: f64::from(view.origin),
        y0: f64::from(y),
        x1: f64::from(view.origin + view.cols as f32 * cw),
        y1: f64::from(y + ch),
    });
    node
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(cells: &[(u32, u32, &str)]) -> RowChars {
        cells.iter().map(|&(c, w, s)| (c, w, s.into())).collect()
    }

    fn view(rows: &[RowChars], cursor: Option<(u32, u32)>) -> View {
        View {
            title: "quad".into(),
            rows: rows.to_vec(),
            cols: 20,
            cell: [10.0, 20.0],
            origin: 2.0,
            cursor,
        }
    }

    fn node(update: &TreeUpdate, id: NodeId) -> &Node {
        &update.nodes.iter().find(|(i, _)| *i == id).unwrap().1
    }

    #[test]
    fn rows_are_lines_of_text_where_their_cells_are() {
        // "hi  界!" with a gap, a wide character, and a mark.
        let rows = [
            chars(&[(0, 1, "h"), (1, 1, "i"), (4, 2, "界"), (6, 1, "e\u{301}")]),
            chars(&[(0, 1, "x")]),
        ];
        let tree = whole_tree(&view(&rows, None));
        assert_eq!(tree.tree.as_ref().unwrap().root, WINDOW);
        assert_eq!(node(&tree, WINDOW).children(), [TERMINAL]);
        assert_eq!(node(&tree, TERMINAL).children(), [row_id(0), row_id(1)]);
        let first = node(&tree, row_id(0));
        assert_eq!(first.value(), Some("hi  界e\u{301}\n"));
        assert_eq!(first.character_lengths(), [1, 1, 1, 1, 3, 3, 1]);
        assert_eq!(
            first.character_positions(),
            Some(&[0.0, 10.0, 20.0, 30.0, 40.0, 60.0, 70.0][..])
        );
        assert_eq!(
            first.character_widths(),
            Some(&[10.0, 10.0, 10.0, 10.0, 20.0, 10.0, 0.0][..])
        );
        assert_eq!(first.word_starts(), [0, 4]);
        let bounds = first.bounds().unwrap();
        assert_eq!((bounds.y0, bounds.y1, bounds.x1), (2.0, 22.0, 202.0));
        // The last row ends with no newline.
        assert_eq!(node(&tree, row_id(1)).value(), Some("x"));
    }

    #[test]
    fn the_cursor_is_the_selection_and_has_a_character() {
        let rows = [chars(&[(0, 1, "a"), (2, 2, "界"), (4, 1, "b")]), chars(&[])];
        let at = |cursor| {
            let tree = whole_tree(&view(&rows, Some(cursor)));
            let selection = *node(&tree, TERMINAL).text_selection().unwrap();
            assert_eq!(selection.anchor, selection.focus);
            (selection.focus.node, selection.focus.character_index)
        };
        assert_eq!(at((0, 0)), (row_id(0), 0));
        assert_eq!(at((0, 1)), (row_id(0), 1), "the blank between");
        assert_eq!(at((0, 3)), (row_id(0), 2), "the second cell of 界");
        assert_eq!(at((0, 4)), (row_id(0), 3));
        // Past the end of an empty row: blanks up to it.
        let tree = whole_tree(&view(&rows, Some((1, 2))));
        assert_eq!(node(&tree, row_id(1)).value(), Some("   "));
        assert_eq!(
            node(&tree, TERMINAL).text_selection().unwrap().focus,
            TextPosition {
                node: row_id(1),
                character_index: 2
            }
        );
    }

    #[test]
    fn a_frame_updates_the_rows_it_changed() {
        let rows = [chars(&[(0, 1, "a")]), chars(&[(0, 1, "b")]), chars(&[])];
        let update = changed_rows(&view(&rows, None), &[false, true, false]);
        let ids: Vec<NodeId> = update.nodes.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, [TERMINAL, row_id(1)]);
        assert!(update.tree.is_none());
        assert_eq!(update.focus, TERMINAL);
    }
}
