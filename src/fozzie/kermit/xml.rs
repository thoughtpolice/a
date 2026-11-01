// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! The XML-ish parse-tree mutator, radamsa's `xp`.
//!
//! A lenient lexer finds open, close and self-closing tags with their
//! attributes, and pairs each close with the latest matching open to form
//! elements. Anything else stays bytes. The mutator remembers every tag and
//! attribute it has seen across blocks, so it can insert a tag from one
//! document into another. A bare numeric attribute value becomes a number
//! the `num` mutator rewrites on each use.
//!
//! A mutated block comes back in a compact rendering: one space between
//! attributes, nothing before `>`, and ` />` for a self-closing tag.

use crate::MAX_DEPTH;
use crate::number;
use crate::source::Source;
use num_bigint::BigInt;

/// The most tags, and attributes per tag, the mutator remembers.
const MAX_TAGS: usize = 256;
const MAX_ATTRIBUTES: usize = 32;

/// radamsa pumps and repeats nodes up to 16385 times. Kermit stops at
/// 1025, as `tr` does, which bounds a 4 KiB block's growth to a few MiB.
const MAX_PUMPS: usize = 1 << 10;

type Name = Vec<u8>;
type Attribute = (Name, Option<Vec<u8>>);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Node {
    Bytes(Vec<u8>),
    /// `<name attributes>` with no matching close.
    Open(Name, Vec<Attribute>),
    /// `<name attributes />`
    Single(Name, Vec<Attribute>),
    /// `</name>` with no matching open.
    Close(Name),
    /// An open tag, its content and its close.
    Element(Name, Vec<Attribute>, Vec<Node>),
    /// Two nodes side by side, made by a mutation.
    Pair(Box<Node>, Box<Node>),
}

/// The tags and attributes seen so far.
#[derive(Clone, Debug, Default)]
pub struct TagStore(Vec<Tag>);

#[derive(Clone, Debug)]
struct Tag {
    name: Name,
    kind: Kind,
    attributes: Vec<(Name, Value)>,
}

/// How a tag has appeared. A later sighting can only raise the kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Open,
    Single,
    Full,
}

#[derive(Clone, Debug)]
enum Value {
    Absent,
    Bytes(Vec<u8>),
    Number(BigInt),
}

/// Mutates the elements of an XML-ish block. A block with no tags is
/// refused, but its tags, if any, are still learned.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>, store: &mut TagStore) -> i8 {
    let mut nodes = shrub(lex(block));
    store.learn(&nodes);
    if nodes.iter().all(|node| matches!(node, Node::Bytes(_))) {
        return -1;
    }
    let changed = match source.below(6) {
        0 => swap(source, &mut nodes),
        1 => duplicate(source, &mut nodes),
        2 => pump(source, &mut nodes),
        3 => repeat(source, &mut nodes),
        _ => false,
    };
    // radamsa redraws until an operation changes something. Insertion
    // always does, so kermit falls back to it, which keeps the number of
    // draws bounded when a shrinker feeds zeros.
    if !changed {
        insert(source, &mut nodes, store);
    }
    *block = render(&nodes);
    1
}

/// Swaps two tags or elements. When one holds the other, the outer one
/// becomes the inner one.
fn swap<S: Source>(source: &mut S, nodes: &mut [Node]) -> bool {
    let opens = find(nodes, is_open);
    if opens.len() < 2 {
        return false;
    }
    let (a, b) = source.two_of(opens.len());
    let (a, b) = (&opens[a], &opens[b]);
    let (first, second) = (get(nodes, a).clone(), get(nodes, b).clone());
    if b.starts_with(a) {
        *get_mut(nodes, a) = second;
    } else if a.starts_with(b) {
        *get_mut(nodes, b) = first;
    } else {
        *get_mut(nodes, a) = second;
        *get_mut(nodes, b) = first;
    }
    true
}

fn duplicate<S: Source>(source: &mut S, nodes: &mut [Node]) -> bool {
    let opens = find(nodes, is_open);
    if opens.is_empty() {
        return false;
    }
    let target = get_mut(nodes, &opens[source.below(opens.len())]);
    *target = Node::Pair(Box::new(target.clone()), Box::new(target.clone()));
    true
}

/// Picks an element, preferring outer ones, and a node inside it, then
/// replaces that node with the element nested in itself 2 or more times.
fn pump<S: Source>(source: &mut S, nodes: &mut [Node]) -> bool {
    let elements = find(nodes, |node| matches!(node, Node::Element(..)));
    if elements.is_empty() {
        return false;
    }
    let mut pick = 0;
    while pick + 1 < elements.len() && source.below(2) != 0 {
        pick += 1;
    }
    let start = get(nodes, &elements[pick]).clone();
    let inner = find(std::slice::from_ref(&start), is_bytes_or_element);
    // The first path is the element itself, which would change nothing.
    let targets = &inner[1..];
    if targets.is_empty() {
        return false;
    }
    let end = &targets[source.below(targets.len())];
    let mut branch = start.clone();
    // Each pump nests the element `end.len()` levels deeper.
    let count = pumps(source).min((MAX_DEPTH / end.len()).max(1));
    for _ in 0..count {
        let mut next = start.clone();
        *get_mut(std::slice::from_mut(&mut next), end) = branch;
        branch = next;
    }
    *get_mut(nodes, &elements[pick]) = branch;
    true
}

fn repeat<S: Source>(source: &mut S, nodes: &mut [Node]) -> bool {
    let opens = find(nodes, is_open);
    if opens.is_empty() {
        return false;
    }
    let target = get_mut(nodes, &opens[source.below(opens.len())]);
    let mut out = target.clone();
    for _ in 0..pumps(source) {
        out = Node::Pair(Box::new(target.clone()), Box::new(out));
    }
    *target = out;
    true
}

/// Wraps a node in, or puts it after, a tag seen in some block, with each
/// of that tag's known attributes kept with probability 1/3.
fn insert<S: Source>(source: &mut S, nodes: &mut [Node], store: &TagStore) {
    let mut options = find(nodes, is_bytes_or_element);
    if options.is_empty() {
        options = find(nodes, |_| true);
    }
    let target = get_mut(nodes, &options[source.below(options.len())]);
    let tag = &store.0[source.below(store.0.len())];
    let mut attributes = Vec::new();
    for (name, value) in &tag.attributes {
        if source.below(3) == 0 {
            let value = match value {
                Value::Absent => None,
                Value::Bytes(bytes) => Some(bytes.clone()),
                Value::Number(number) => Some(
                    number::change(source, number.clone())
                        .to_string()
                        .into_bytes(),
                ),
            };
            attributes.push((name.clone(), value));
        }
    }
    let node = std::mem::replace(target, Node::Bytes(Vec::new()));
    let name = tag.name.clone();
    *target = match tag.kind {
        Kind::Open => Node::Pair(Box::new(Node::Open(name, attributes)), Box::new(node)),
        Kind::Single => Node::Pair(Box::new(Node::Single(name, attributes)), Box::new(node)),
        Kind::Full => Node::Element(name, attributes, vec![node]),
    };
}

/// A repeat count from 2 to `MAX_PUMPS + 1`, favouring small ones.
fn pumps<S: Source>(source: &mut S) -> usize {
    let mut limit = 2;
    while source.below(2) != 0 && limit < MAX_PUMPS {
        limit <<= 1;
    }
    source.below(limit) + 2
}

impl TagStore {
    fn learn(&mut self, nodes: &[Node]) {
        for node in nodes {
            match node {
                Node::Bytes(_) | Node::Pair(..) => {}
                Node::Open(name, attributes) => self.add(name, attributes, Kind::Open),
                Node::Single(name, attributes) => self.add(name, attributes, Kind::Single),
                // A close implies an open somewhere.
                Node::Close(name) => self.add(name, &[], Kind::Full),
                Node::Element(name, attributes, content) => {
                    self.learn(content);
                    self.add(name, attributes, Kind::Full);
                }
            }
        }
    }

    fn add(&mut self, name: &[u8], attributes: &[Attribute], kind: Kind) {
        let index = match self.0.iter().position(|tag| tag.name == name) {
            Some(index) => index,
            None if self.0.len() < MAX_TAGS => {
                self.0.push(Tag {
                    name: name.to_vec(),
                    kind,
                    attributes: Vec::new(),
                });
                self.0.len() - 1
            }
            None => return,
        };
        let tag = &mut self.0[index];
        tag.kind = tag.kind.max(kind);
        for (name, value) in attributes {
            let value = match value {
                None => Value::Absent,
                Some(digits) if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) => {
                    Value::Number(
                        std::str::from_utf8(digits)
                            .expect("digits are ASCII")
                            .parse()
                            .expect("digits parse"),
                    )
                }
                Some(bytes) => Value::Bytes(bytes.clone()),
            };
            match tag.attributes.iter().position(|(known, _)| known == name) {
                Some(index) => tag.attributes[index].1 = value,
                None if tag.attributes.len() < MAX_ATTRIBUTES => {
                    tag.attributes.push((name.clone(), value))
                }
                None => {}
            }
        }
    }
}

fn is_open(node: &Node) -> bool {
    matches!(node, Node::Open(..) | Node::Single(..) | Node::Element(..))
}

fn is_bytes_or_element(node: &Node) -> bool {
    matches!(node, Node::Bytes(_) | Node::Element(..))
}

/// Splits `data` into tags and byte runs.
fn lex(data: &[u8]) -> Vec<Node> {
    let mut nodes = Vec::new();
    let mut at = 0;
    while at < data.len() {
        if data[at] == b'<'
            && let Some((node, end)) = tag(data, at)
        {
            nodes.push(node);
            at = end;
            continue;
        }
        // One byte, then a run of bytes that cannot start a tag or a string.
        let start = at;
        at += 1;
        while at < data.len() && data[at] != b'<' && data[at] != b'"' {
            at += 1;
        }
        match nodes.last_mut() {
            Some(Node::Bytes(bytes)) => bytes.extend_from_slice(&data[start..at]),
            _ => nodes.push(Node::Bytes(data[start..at].to_vec())),
        }
    }
    nodes
}

/// Parses the tag starting with the `<` at `at`, returning it and where it
/// ends.
fn tag(data: &[u8], at: usize) -> Option<(Node, usize)> {
    let mut at = at + 1;
    if data.get(at) == Some(&b'/') {
        at += 1;
        let name = label(data, &mut at)?;
        skip_space(data, &mut at);
        return (data.get(at) == Some(&b'>')).then(|| (Node::Close(name), at + 1));
    }
    let name = label(data, &mut at)?;
    let mut attributes = Vec::new();
    loop {
        let before = at;
        match attribute(data, &mut at) {
            Some(attribute) => attributes.push(attribute),
            None => {
                at = before;
                break;
            }
        }
    }
    skip_space(data, &mut at);
    match (data.get(at), data.get(at + 1)) {
        (Some(b'>'), _) => Some((Node::Open(name, attributes), at + 1)),
        (Some(b'/'), Some(b'>')) => Some((Node::Single(name, attributes), at + 2)),
        _ => None,
    }
}

/// An attribute name, optionally followed by `=` and a value. A value that
/// fails to parse leaves the attribute without one, so the tag fails at the
/// stray `=`.
fn attribute(data: &[u8], at: &mut usize) -> Option<Attribute> {
    skip_space(data, at);
    let name = label(data, at)?;
    skip_space(data, at);
    let after_name = *at;
    if data.get(*at) == Some(&b'=') {
        *at += 1;
        skip_space(data, at);
        if let Some(value) = value(data, at) {
            return Some((name, Some(value)));
        }
        *at = after_name;
    }
    Some((name, None))
}

/// A quoted string, kept with its quotes and escapes, or a bare label.
fn value(data: &[u8], at: &mut usize) -> Option<Vec<u8>> {
    let quote = *data.get(*at)?;
    if quote != b'"' && quote != b'\'' {
        return label(data, at);
    }
    let mut end = *at + 1;
    loop {
        match *data.get(end)? {
            b'\\' => end += 2,
            byte if byte == quote => break,
            _ => end += 1,
        }
    }
    let value = data.get(*at..=end)?.to_vec();
    *at = end + 1;
    Some(value)
}

/// One or more ASCII letters or digits.
fn label(data: &[u8], at: &mut usize) -> Option<Name> {
    let start = *at;
    while data.get(*at).is_some_and(u8::is_ascii_alphanumeric) {
        *at += 1;
    }
    (*at > start).then(|| data[start..*at].to_vec())
}

fn skip_space(data: &[u8], at: &mut usize) {
    while matches!(data.get(*at), Some(b' ' | b'\n')) {
        *at += 1;
    }
}

/// Pairs each close tag with the latest unmatched open tag of the same
/// name, making an element of the nodes between them. A pair that would
/// nest elements deeper than `MAX_DEPTH` stays unpaired.
fn shrub(nodes: Vec<Node>) -> Vec<Node> {
    let mut done: Vec<Node> = Vec::new();
    // How deeply elements nest in each node of `done`.
    let mut depths: Vec<usize> = Vec::new();
    for node in nodes {
        let Node::Close(name) = node else {
            done.push(node);
            depths.push(0);
            continue;
        };
        let open = done
            .iter()
            .rposition(|node| matches!(node, Node::Open(open, _) if *open == name));
        let depth = open.map(|index| 1 + depths[index + 1..].iter().max().unwrap_or(&0));
        match (open, depth) {
            (Some(index), Some(depth)) if depth <= MAX_DEPTH => {
                let content = done.split_off(index + 1);
                depths.truncate(index);
                let Some(Node::Open(name, attributes)) = done.pop() else {
                    unreachable!("rposition found an open tag")
                };
                done.push(Node::Element(name, attributes, content));
                depths.push(depth);
            }
            _ => {
                done.push(Node::Close(name));
                depths.push(0);
            }
        }
    }
    done
}

fn render(nodes: &[Node]) -> Vec<u8> {
    fn open(out: &mut Vec<u8>, name: &[u8], attributes: &[Attribute]) {
        out.push(b'<');
        out.extend_from_slice(name);
        for (name, value) in attributes {
            out.push(b' ');
            out.extend_from_slice(name);
            if let Some(value) = value {
                out.push(b'=');
                out.extend_from_slice(value);
            }
        }
    }
    fn close(out: &mut Vec<u8>, name: &[u8]) {
        out.extend_from_slice(b"</");
        out.extend_from_slice(name);
        out.push(b'>');
    }
    fn walk(node: &Node, out: &mut Vec<u8>) {
        match node {
            Node::Bytes(bytes) => out.extend_from_slice(bytes),
            Node::Open(name, attributes) => {
                open(out, name, attributes);
                out.push(b'>');
            }
            Node::Single(name, attributes) => {
                open(out, name, attributes);
                out.extend_from_slice(b" />");
            }
            Node::Close(name) => close(out, name),
            Node::Element(name, attributes, content) => {
                open(out, name, attributes);
                out.push(b'>');
                content.iter().for_each(|node| walk(node, out));
                close(out, name);
            }
            Node::Pair(a, b) => {
                walk(a, out);
                walk(b, out);
            }
        }
    }
    let mut out = Vec::new();
    nodes.iter().for_each(|node| walk(node, &mut out));
    out
}

/// The paths of the nodes in `nodes` that satisfy `want`, outer nodes
/// first. A path steps into an element's content, or into a pair's left
/// (0) or right (1) node.
fn find(nodes: &[Node], want: fn(&Node) -> bool) -> Vec<Vec<usize>> {
    fn walk(
        node: &Node,
        path: &mut Vec<usize>,
        want: fn(&Node) -> bool,
        out: &mut Vec<Vec<usize>>,
    ) {
        if want(node) {
            out.push(path.clone());
        }
        for (index, child) in children(node).into_iter().enumerate() {
            path.push(index);
            walk(child, path, want, out);
            path.pop();
        }
    }
    let mut out = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        walk(node, &mut vec![index], want, &mut out);
    }
    out
}

fn children(node: &Node) -> Vec<&Node> {
    match node {
        Node::Element(_, _, content) => content.iter().collect(),
        Node::Pair(a, b) => vec![&**a, &**b],
        _ => Vec::new(),
    }
}

fn get<'a>(nodes: &'a [Node], path: &[usize]) -> &'a Node {
    let mut node = &nodes[path[0]];
    for &index in &path[1..] {
        node = children(node)[index];
    }
    node
}

fn get_mut<'a>(nodes: &'a mut [Node], path: &[usize]) -> &'a mut Node {
    let mut node = &mut nodes[path[0]];
    for &index in &path[1..] {
        node = match node {
            Node::Element(_, _, content) => &mut content[index],
            Node::Pair(a, _) if index == 0 => &mut **a,
            Node::Pair(_, b) => &mut **b,
            _ => unreachable!("paths descend through elements and pairs"),
        };
    }
    node
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    fn run(draws: &[usize], input: &[u8], store: &mut TagStore) -> (i8, String) {
        let mut block = input.to_vec();
        let delta = mutate(&mut Script::new(draws), &mut block, store);
        (delta, String::from_utf8(block).expect("tests use ASCII"))
    }

    fn parse(input: &[u8]) -> Vec<Node> {
        shrub(lex(input))
    }

    #[test]
    fn lexes_tags_and_pairs_elements() {
        let nodes = parse(b"<a x=\"1\" y=2><b/>text</a>");
        let [Node::Element(name, attributes, content)] = &nodes[..] else {
            panic!("{nodes:?}")
        };
        assert_eq!(name, b"a");
        assert_eq!(
            attributes,
            &[
                (b"x".to_vec(), Some(b"\"1\"".to_vec())),
                (b"y".to_vec(), Some(b"2".to_vec()))
            ]
        );
        assert_eq!(
            content,
            &[
                Node::Single(b"b".to_vec(), vec![]),
                Node::Bytes(b"text".to_vec())
            ]
        );
    }

    #[test]
    fn renders_compactly() {
        assert_eq!(render(&parse(b"<a  x = 1 ><b/></a>")), b"<a x=1><b /></a>");
        assert_eq!(render(&parse(b"<a x='q\\'r'>t</a>")), b"<a x='q\\'r'>t</a>");
        // Unmatched tags stay as they are.
        assert_eq!(render(&parse(b"</z><y>")), b"</z><y>");
    }

    #[test]
    fn broken_tags_are_bytes() {
        for input in [&b"a < b and \"c\""[..], b"<a x=\"1>", b"<a x=>", b"< a>"] {
            assert!(
                parse(input)
                    .iter()
                    .all(|node| matches!(node, Node::Bytes(_))),
                "{input:?}"
            );
            assert_eq!(render(&parse(input)), input);
        }
        let mut store = TagStore::default();
        assert_eq!(
            run(&[], b"no tags here", &mut store),
            (-1, "no tags here".to_string())
        );
    }

    #[test]
    fn swaps_and_duplicates_elements() {
        let mut store = TagStore::default();
        assert_eq!(run(&[0, 0, 0], b"<a/><b/>", &mut store).1, "<b /><a />");
        assert_eq!(run(&[1, 0], b"<a>x</a>", &mut store).1, "<a>x</a><a>x</a>");
    }

    #[test]
    fn pumps_an_element_into_itself() {
        let mut store = TagStore::default();
        // Pick <a>, target <b>, two pumps.
        let (_, out) = run(&[2, 0, 0, 0, 0], b"<a><b>x</b></a>", &mut store);
        assert_eq!(out, "<a><a><a><b>x</b></a></a></a>");
    }

    #[test]
    fn repeats_an_element() {
        let mut store = TagStore::default();
        assert_eq!(run(&[3, 0, 0, 0], b"<a/>", &mut store).1, "<a /><a /><a />");
    }

    #[test]
    fn inserts_tags_learned_from_earlier_blocks() {
        let mut store = TagStore::default();
        run(&[1, 0], b"<p>x</p>", &mut store);
        // Insert, around the bytes "y", the first tag learned.
        assert_eq!(
            run(&[4, 1, 0], b"<q>y</q>", &mut store).1,
            "<q><p>y</p></q>"
        );
    }

    #[test]
    fn numeric_attributes_become_new_numbers() {
        let mut store = TagStore::default();
        // Insert next to the only node, keep attribute n, and add one to it.
        assert_eq!(
            run(&[4, 0, 0, 0, 0], b"<i n=5/>", &mut store).1,
            "<i n=6 /><i n=5 />"
        );
    }

    #[test]
    fn failed_operations_fall_back_to_insertion() {
        let mut store = TagStore::default();
        // A swap needs two tags, so the lone <a> gets a tag inserted instead.
        let (delta, out) = run(&[0, 0, 0], b"<a>t</a>", &mut store);
        assert_eq!((delta, out.as_str()), (1, "<a><a>t</a></a>"));
    }
}
