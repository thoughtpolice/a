// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A project's files, as people mean them: those its ignore files do not
//! ignore (`.gitignore`, `.ignore`, git's excludes, with or without a git
//! repository, as a jj one may have none), and never a version control
//! system's own. [`project_files`] lists them; [`Grep`] searches them, on
//! threads of its own, its hits arriving through a [`Mailbox`].

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use chez::{IntoScheme, Mailbox, Scope, Value};
use ignore::{WalkBuilder, WalkState};
use regex::bytes::{Regex, RegexBuilder};

/// Directories never walked into: version control's, and what builds
/// leave, for directories no ignore file covers.
const SKIPPED: &[&str] = &[
    ".git",
    ".jj",
    ".hg",
    ".sl",
    "buck-out",
    "node_modules",
    "target",
    "_build",
    ".direnv",
    "zig-cache",
    ".zig-cache",
];

fn walker(dir: &str) -> WalkBuilder {
    let mut b = WalkBuilder::new(dir);
    b.hidden(false).require_git(false).filter_entry(|e| {
        !(e.file_type().is_some_and(|t| t.is_dir())
            && e.file_name().to_str().is_some_and(|n| SKIPPED.contains(&n)))
    });
    b
}

/// `path` under `dir`, relative to it, with "/" between its parts.
fn relative(dir: &Path, path: &Path) -> Option<String> {
    // As both Linux and macOS have them.
    path.strip_prefix(dir).ok()?.to_str().map(String::from)
}

/// The lines of `bytes` that `re` matches in or from, with their numbers:
/// all of `bytes` searched, from the line after each found.
fn lines_matched<'b>(re: &Regex, bytes: &'b [u8]) -> impl Iterator<Item = (usize, &'b [u8])> {
    // Where the line searched from starts, and its number.
    let (mut start, mut line) = (0, 0);
    std::iter::from_fn(move || {
        if start > bytes.len() {
            return None;
        }
        let m = re.find_at(bytes, start)?;
        // The line it starts in, past the newlines before it.
        let before = &bytes[start..m.start()];
        line += before.iter().filter(|&&b| b == b'\n').count();
        if let Some(n) = before.iter().rposition(|&b| b == b'\n') {
            start += n + 1;
        }
        let end = bytes[m.start()..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |n| m.start() + n);
        let found = (line, &bytes[start..end]);
        (start, line) = (end + 1, line + 1);
        Some(found)
    })
}

/// The files under `dir`, relative to it, in order of their paths' names
/// (a directory's files before its subdirectories' are not promised), at
/// most `limit` of them.
pub fn project_files(dir: &str, limit: usize) -> Vec<String> {
    let root = Path::new(dir);
    walker(dir)
        .sort_by_file_name(|a, b| a.cmp(b))
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|e| relative(root, e.path()))
        .take(limit)
        .collect()
}

/// What a search of the files finds: a line that matches, or the end.
pub enum Found {
    /// The file's path (relative), the line (from 0), the column of the
    /// match in characters, and the line's text (some of it, if long).
    Hit(String, usize, usize, String),
    /// Every file was searched, or the search stopped: how many hits, and
    /// whether it stopped at its limit.
    Done(usize, bool),
}

impl IntoScheme for Found {
    fn into_scheme(self, s: &Scope) -> chez::Result<Value<'_>> {
        let int = |n: usize| s.integer(n as i64);
        Ok(match self {
            Found::Hit(path, line, col, text) => s.list([
                s.string("hit"),
                s.string(&path),
                int(line),
                int(col),
                s.string(&text),
            ]),
            Found::Done(n, stopped) => s.list([s.string("done"), int(n), s.boolean(stopped)]),
        })
    }
}

/// The most hits a search makes; then it stops.
const MAX_HITS: usize = 10_000;

/// Files bigger than this are not searched (a log, an image).
const MAX_FILE: u64 = 16 * 1024 * 1024;

/// The most of a line a hit carries.
const MAX_TEXT: usize = 400;

/// A search of a directory's files for a pattern, until done or dropped.
pub struct Grep {
    pub found: Mailbox<Found>,
    stop: Arc<AtomicBool>,
}

impl Drop for Grep {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Grep {
    /// Search the files under `dir` for `pattern`: a regular expression
    /// (the regex crate's syntax) if `regex`, else the text itself; case
    /// ignored if `fold`.
    pub fn start(dir: &str, pattern: &str, regex: bool, fold: bool) -> Result<Grep, String> {
        let pattern = if regex {
            pattern.to_string()
        } else {
            regex::escape(pattern)
        };
        // Lines are matched one at a time, so that `\A` and `\z` are a
        // line's ends; any other pattern matches in a line only where it
        // matches in the whole file (^ and $ being lines' ends in both), so
        // the file is searched instead, and only the lines it matches in
        // are, as most files have no match.
        let whole_first = !(pattern.contains("\\A") || pattern.contains("\\z"));
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(fold)
            .multi_line(true)
            .build()
            .map_err(|e| e.to_string())?;
        let (tx, found) = Mailbox::new().map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let root = dir.to_string();
        let walk = walker(dir).build_parallel();
        {
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("quad-grep".into())
                .spawn(move || {
                    let hits = AtomicUsize::new(0);
                    let root = Path::new(&root);
                    walk.run(|| {
                        let (re, tx, stop, hits) = (&re, tx.clone(), &stop, &hits);
                        Box::new(move |entry| {
                            if stop.load(Ordering::Relaxed) {
                                return WalkState::Quit;
                            }
                            let Ok(entry) = entry else {
                                return WalkState::Continue;
                            };
                            if !entry.file_type().is_some_and(|t| t.is_file())
                                || entry.metadata().is_ok_and(|m| m.len() > MAX_FILE)
                            {
                                return WalkState::Continue;
                            }
                            let (Ok(bytes), Some(rel)) =
                                (std::fs::read(entry.path()), relative(root, entry.path()))
                            else {
                                return WalkState::Continue;
                            };
                            // A NUL near the start: a binary file.
                            if bytes[..bytes.len().min(8192)].contains(&0) {
                                return WalkState::Continue;
                            }
                            let mut hit = |line: usize, text: &[u8]| {
                                let Some(m) = re.find(text) else {
                                    return true;
                                };
                                if hits.fetch_add(1, Ordering::Relaxed) >= MAX_HITS {
                                    stop.store(true, Ordering::Relaxed);
                                    return false;
                                }
                                let col =
                                    String::from_utf8_lossy(&text[..m.start()]).chars().count();
                                // Its start: a line can be a whole minified file.
                                let shown = &text[..text.len().min(4 * MAX_TEXT)];
                                let text: String = String::from_utf8_lossy(shown)
                                    .chars()
                                    .take(MAX_TEXT)
                                    .collect();
                                tx.send(Found::Hit(rel.clone(), line, col, text)).is_ok()
                            };
                            let more = if whole_first {
                                lines_matched(re, &bytes).all(|(line, text)| hit(line, text))
                            } else {
                                (bytes.split(|&b| b == b'\n').enumerate())
                                    .all(|(line, text)| hit(line, text))
                            };
                            if more {
                                WalkState::Continue
                            } else {
                                WalkState::Quit
                            }
                        })
                    });
                    let n = hits.load(Ordering::Relaxed).min(MAX_HITS);
                    let _ = tx.send(Found::Done(n, n >= MAX_HITS));
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(Grep { found, stop })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quad-files-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for (path, text) in [
            ("a.txt", "one\ntwo needle\n"),
            ("sub/b.txt", "needle at the start\n"),
            ("ignored.log", "needle\n"),
            (".gitignore", "*.log\n"),
            (".jj/repo/x", "needle\n"),
            ("bin", "needle\0binary"),
        ] {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    #[test]
    fn ignored_files_are_not_the_projects() {
        let dir = tree();
        let files = project_files(dir.to_str().unwrap(), 100);
        assert_eq!(files, [".gitignore", "a.txt", "bin", "sub/b.txt"]);
        assert_eq!(project_files(dir.to_str().unwrap(), 2).len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Searching a whole file finds the lines that matching each line alone
    /// does, at the same places: for patterns that do not name the text's
    /// ends, and some that cross lines.
    #[hegel::test(test_cases = 500, database = None)]
    fn whole_files_match_where_their_lines_do(tc: hegel::TestCase) {
        use hegel::generators as gs;
        let alphabet = [b'a', b'b', b' ', b'\n'];
        let bytes: Vec<u8> = (0..tc.draw(gs::integers::<usize>().max_value(40)))
            .map(|_| alphabet[tc.draw(gs::integers::<usize>().max_value(3))])
            .collect();
        let patterns = [
            r"a", r"ab+", r"^b", r"a$", r"^$", r"\bb", r"\s+", r"a\nb", r"b?", r"$",
        ];
        let pattern = patterns[tc.draw(gs::integers::<usize>().max_value(patterns.len() - 1))];
        let re = RegexBuilder::new(pattern).multi_line(true).build().unwrap();
        let each = |line: usize, text: &[u8]| re.find(text).map(|m| (line, m.start()));
        let alone: Vec<_> = (bytes.split(|&b| b == b'\n').enumerate())
            .filter_map(|(line, text)| each(line, text))
            .collect();
        let whole: Vec<_> = lines_matched(&re, &bytes)
            .filter_map(|(line, text)| each(line, text))
            .collect();
        assert_eq!(
            whole,
            alone,
            "{pattern:?} in {:?}",
            String::from_utf8_lossy(&bytes)
        );
    }

    #[test]
    fn grep_finds_lines_in_the_projects_text_files() {
        let dir = tree();
        let grep = Grep::start(dir.to_str().unwrap(), "NEEDLE", false, true).unwrap();
        let mut hits = Vec::new();
        let mut done = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while done.is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the search did not finish"
            );
            for found in grep.found.take() {
                match found {
                    Found::Hit(path, line, col, text) => hits.push((path, line, col, text)),
                    Found::Done(n, stopped) => done = Some((n, stopped)),
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let done = done.unwrap();
        hits.sort();
        assert_eq!(
            hits,
            [
                ("a.txt".into(), 1, 4, "two needle".into()),
                ("sub/b.txt".into(), 0, 0, "needle at the start".into())
            ]
        );
        assert_eq!(done, (2, false));
        assert!(Grep::start(dir.to_str().unwrap(), "(", true, false).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
