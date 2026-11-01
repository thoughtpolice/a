// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Guessed parse-tree mutators, radamsa's `td`, `tr2`, `ts1`, `ts2` and
//! `tr`.
//!
//! A forgiving parser reads `()`, `[]`, `<>`, `{}`, `""` and `''` as nested
//! nodes. An opener whose closer never comes stays a plain byte, so every
//! block parses and the tree flattens back to the same bytes. The mutators
//! then delete, duplicate, swap or recursively repeat nodes.

use crate::MAX_DEPTH;
use crate::lines::binarish;
use crate::source::Source;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tree {
    Byte(u8),
    /// A delimited node. Its first and last children are the delimiters.
    Node(Vec<Tree>),
}

/// A node's position, as the child index at each level from the top.
type Path = Vec<usize>;

#[derive(Clone, Copy, Debug)]
pub enum TreeOp {
    Delete,
    Duplicate,
    SwapOne,
    SwapTwo,
    Stutter,
}

/// Applies `op` to the guessed tree of `block`. Binary-looking data is
/// refused, as is a swap or stutter with too few nodes to work with.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>, op: TreeOp) -> i8 {
    if binarish(block) {
        return -1;
    }
    let mut trees = parse(block);
    let nodes = paths(&trees);
    match op {
        TreeOp::Delete | TreeOp::Duplicate => {
            if !nodes.is_empty() {
                let path = &nodes[source.below(nodes.len())];
                let (parent, index) = parent_mut(&mut trees, path);
                if matches!(op, TreeOp::Delete) {
                    parent.remove(index);
                } else {
                    parent.insert(index, parent[index].clone());
                }
            }
        }
        TreeOp::SwapOne | TreeOp::SwapTwo if nodes.len() < 2 => return -1,
        TreeOp::SwapOne => {
            let (a, b) = source.two_of(nodes.len());
            *get_mut(&mut trees, &nodes[a]) = get(&trees, &nodes[b]).clone();
        }
        TreeOp::SwapTwo => {
            let (a, b) = source.two_of(nodes.len());
            swap(&mut trees, &nodes[a], &nodes[b]);
        }
        TreeOp::Stutter => {
            if !stutter(source, &mut trees, &nodes) {
                return -1;
            }
        }
    }
    *block = flatten(&trees);
    1
}

/// Swaps two nodes. When one contains the other, the outer one is replaced
/// by the inner one, as a walk that replaces whichever it meets first would.
fn swap(trees: &mut Vec<Tree>, a: &Path, b: &Path) {
    let (first, second) = (get(trees, a).clone(), get(trees, b).clone());
    if b.starts_with(a) {
        *get_mut(trees, a) = second;
    } else if a.starts_with(b) {
        *get_mut(trees, b) = first;
    } else {
        *get_mut(trees, a) = second;
        *get_mut(trees, b) = first;
    }
}

/// Picks a node with a node inside it, and replaces that inner node with
/// the outer one nested up to 1023 times: `f(x)` becomes `f(f(f(x)))`.
fn stutter<S: Source>(source: &mut S, trees: &mut Vec<Tree>, nodes: &[Path]) -> bool {
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    source.shuffle(&mut order);
    let mut found = None;
    for index in order {
        let inner = paths(children(get(trees, &nodes[index])));
        if !inner.is_empty() {
            found = Some((index, inner[source.below(inner.len())].clone()));
            break;
        }
    }
    let Some((parent, child)) = found else {
        return false;
    };
    // Each level nests the child `child.len()` levels deeper.
    let levels = source.log(10).max(1).min((MAX_DEPTH / child.len()).max(1));
    let outer = get(trees, &nodes[parent]).clone();
    let mut value = outer.clone();
    for _ in 1..levels {
        let mut next = outer.clone();
        let Tree::Node(level) = &mut next else {
            unreachable!("paths name nodes")
        };
        *get_mut(level, &child) = value;
        value = next;
    }
    let mut target = nodes[parent].clone();
    target.extend_from_slice(&child);
    *get_mut(trees, &target) = value;
    true
}

/// Parses `data` into a forest of bytes and delimited nodes.
pub fn parse(data: &[u8]) -> Vec<Tree> {
    grow(data, &mut 0, None, 0).0
}

fn closer(byte: u8) -> Option<u8> {
    match byte {
        b'(' => Some(b')'),
        b'[' => Some(b']'),
        b'<' => Some(b'>'),
        b'{' => Some(b'}'),
        b'"' => Some(b'"'),
        b'\'' => Some(b'\''),
        _ => None,
    }
}

/// Reads until `close`, returning the children read and whether `close` was
/// found. At the end of the data, an unclosed opener and its contents are
/// returned as siblings instead of a node. Openers deeper than
/// `MAX_DEPTH` are plain bytes, which bounds the recursion.
fn grow(data: &[u8], at: &mut usize, close: Option<u8>, depth: usize) -> (Vec<Tree>, bool) {
    let mut out = Vec::new();
    while let Some(&byte) = data.get(*at) {
        *at += 1;
        if Some(byte) == close {
            out.push(Tree::Byte(byte));
            return (out, true);
        }
        match closer(byte).filter(|_| depth < MAX_DEPTH) {
            Some(next) => {
                let (inner, closed) = grow(data, at, Some(next), depth + 1);
                if closed {
                    let mut node = vec![Tree::Byte(byte)];
                    node.extend(inner);
                    out.push(Tree::Node(node));
                } else {
                    out.push(Tree::Byte(byte));
                    out.extend(inner);
                }
            }
            None => out.push(Tree::Byte(byte)),
        }
    }
    (out, false)
}

pub fn flatten(trees: &[Tree]) -> Vec<u8> {
    fn walk(trees: &[Tree], out: &mut Vec<u8>) {
        for tree in trees {
            match tree {
                Tree::Byte(byte) => out.push(*byte),
                Tree::Node(children) => walk(children, out),
            }
        }
    }
    let mut out = Vec::new();
    walk(trees, &mut out);
    out
}

/// The paths of every node in `trees`, outer nodes before the nodes inside
/// them.
fn paths(trees: &[Tree]) -> Vec<Path> {
    fn walk(trees: &[Tree], prefix: &mut Path, out: &mut Vec<Path>) {
        for (index, tree) in trees.iter().enumerate() {
            if let Tree::Node(children) = tree {
                prefix.push(index);
                out.push(prefix.clone());
                walk(children, prefix, out);
                prefix.pop();
            }
        }
    }
    let mut out = Vec::new();
    walk(trees, &mut Vec::new(), &mut out);
    out
}

fn children(tree: &Tree) -> &[Tree] {
    match tree {
        Tree::Node(children) => children,
        Tree::Byte(_) => unreachable!("paths name nodes"),
    }
}

fn get<'a>(trees: &'a [Tree], path: &[usize]) -> &'a Tree {
    let (&last, outer) = path.split_last().expect("a node path is nonempty");
    let mut level = trees;
    for &index in outer {
        level = children(&level[index]);
    }
    &level[last]
}

fn get_mut<'a>(trees: &'a mut Vec<Tree>, path: &[usize]) -> &'a mut Tree {
    let (parent, index) = parent_mut(trees, path);
    &mut parent[index]
}

/// The list holding the node at `path`, and the node's index in it.
fn parent_mut<'a>(trees: &'a mut Vec<Tree>, path: &[usize]) -> (&'a mut Vec<Tree>, usize) {
    let (&last, outer) = path.split_last().expect("a node path is nonempty");
    let mut level = trees;
    for &index in outer {
        let Tree::Node(children) = &mut level[index] else {
            unreachable!("paths descend through nodes")
        };
        level = children;
    }
    (level, last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    fn run(draws: &[usize], input: &[u8], op: TreeOp) -> (i8, String) {
        let mut block = input.to_vec();
        let delta = mutate(&mut Script::new(draws), &mut block, op);
        (delta, String::from_utf8(block).expect("tests use ASCII"))
    }

    #[test]
    fn parses_nested_and_unclosed_delimiters() {
        let trees = parse(b"f(a[b]) (x");
        assert_eq!(paths(&trees), vec![vec![1], vec![1, 2]]);
        assert_eq!(flatten(&trees), b"f(a[b]) (x");
        // The unclosed "(" stays a byte, and "[1]" inside it still parses.
        assert_eq!(paths(&parse(b"(a [1]")), vec![vec![3]]);
    }

    #[test]
    fn deletes_and_duplicates_nodes() {
        assert_eq!(
            run(&[1], b"f(a[b])", TreeOp::Delete),
            (1, "f(a)".to_string())
        );
        assert_eq!(
            run(&[0], b"f(a[b])", TreeOp::Duplicate),
            (1, "f(a[b])(a[b])".to_string())
        );
        assert_eq!(run(&[], b"plain", TreeOp::Delete), (1, "plain".to_string()));
    }

    #[test]
    fn swaps_nodes() {
        // The nodes are (1) and [2]. Overwrite the first with the second.
        assert_eq!(
            run(&[0, 0], b"(1)[2]", TreeOp::SwapOne),
            (1, "[2][2]".to_string())
        );
        assert_eq!(
            run(&[0, 0], b"(1)[2]", TreeOp::SwapTwo),
            (1, "[2](1)".to_string())
        );
        // A node swapped with one inside it becomes the inner one.
        assert_eq!(
            run(&[0, 0], b"(a[b])", TreeOp::SwapTwo),
            (1, "[b]".to_string())
        );
        assert_eq!(
            run(&[], b"(only)", TreeOp::SwapOne),
            (-1, "(only)".to_string())
        );
    }

    #[test]
    fn deep_openers_become_bytes() {
        fn depth(trees: &[Tree]) -> usize {
            trees
                .iter()
                .map(|tree| match tree {
                    Tree::Byte(_) => 0,
                    Tree::Node(children) => 1 + depth(children),
                })
                .max()
                .unwrap_or(0)
        }
        let deep = [vec![b'['; 600], vec![b']'; 600]].concat();
        let trees = parse(&deep);
        assert_eq!(depth(&trees), MAX_DEPTH);
        assert_eq!(flatten(&trees), deep);
    }

    #[test]
    fn stutter_nests_a_node_in_itself() {
        // Keep the node order, pick f's only inner node, nest three levels.
        let (delta, out) = run(&[0, 0, 0, 2, 1], b"f(a(b))", TreeOp::Stutter);
        assert_eq!(delta, 1);
        assert_eq!(out, "f(a(a(a(a(b)))))");
        assert_eq!(run(&[], b"(flat)", TreeOp::Stutter).0, -1);
    }

    #[test]
    fn binary_data_is_refused() {
        assert_eq!(run(&[], "(\u{e9})".as_bytes(), TreeOp::Delete).0, -1);
    }
}
