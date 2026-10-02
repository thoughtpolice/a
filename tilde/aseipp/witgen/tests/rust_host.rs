// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The Rust host bindings of tests/host.wit, run against a guest memory of
//! the test's own: what the bindings read out of it, what they write back,
//! in what order they allocate, and where they trap.

mod host;

use host::host_test::{self, HostTest};
use host::things::{self, Color, Item, Listing, Point, Things};
use host::{Flat, Guest, Trap};

#[derive(Debug, PartialEq)]
enum Error {
    OutOfBounds,
    Trap(Trap),
}

/// A guest's linear memory, with a bump allocator that records what it
/// was asked for.
struct Memory {
    bytes: Vec<u8>,
    next: u32,
}

impl Memory {
    fn new() -> Self {
        Memory {
            bytes: vec![0xaa; 4096],
            next: 1024,
        }
    }

    fn put(&mut self, at: u32, bytes: &[u8]) {
        self.bytes[at as usize..at as usize + bytes.len()].copy_from_slice(bytes);
    }

    fn word(&self, at: u32) -> u32 {
        u32::from_le_bytes(self.bytes[at as usize..at as usize + 4].try_into().unwrap())
    }

    fn get(&self, at: u32, len: u32) -> &[u8] {
        &self.bytes[at as usize..(at + len) as usize]
    }
}

impl Guest<Host> for Memory {
    type Error = Error;

    fn read(&self, ptr: u32, len: u32) -> Result<&[u8], Error> {
        let end = ptr as usize + len as usize;
        self.bytes.get(ptr as usize..end).ok_or(Error::OutOfBounds)
    }

    fn write(&mut self, ptr: u32, bytes: &[u8]) -> Result<(), Error> {
        let end = ptr as usize + bytes.len();
        self.bytes
            .get_mut(ptr as usize..end)
            .ok_or(Error::OutOfBounds)?
            .copy_from_slice(bytes);
        Ok(())
    }

    fn alloc(&mut self, host: &mut Host, align: u32, len: u32) -> Result<u32, Error> {
        assert_ne!(len, 0, "the bindings allocate nothing for an empty value");
        let ptr = self.next.next_multiple_of(align);
        self.next = ptr + len;
        host.allocations.push((ptr, align, len));
        Ok(ptr)
    }

    fn trap(&self, trap: Trap) -> Error {
        Error::Trap(trap)
    }
}

#[derive(Default)]
struct Host {
    calls: Vec<String>,
    allocations: Vec<(u32, u32, u32)>,
}

impl Things for Host {
    type Error = Error;

    fn scalars(
        &mut self,
        a: bool,
        b: u8,
        c: i8,
        d: u16,
        e: i16,
        f: u32,
        g: i32,
        h: u64,
        i: i64,
        j: f32,
        k: f64,
        l: char,
    ) -> Result<u64, Error> {
        self.calls
            .push(format!("{a} {b} {c} {d} {e} {f} {g} {h} {i} {j} {k} {l}"));
        Ok(u64::MAX - 1)
    }

    fn negate(&mut self, value: i16) -> Result<i16, Error> {
        Ok(value.wrapping_neg())
    }

    fn halve(&mut self, value: f64) -> Result<f64, Error> {
        Ok(value / 2.0)
    }

    fn enums(&mut self, c: Color, p: u32) -> Result<Color, Error> {
        assert_eq!(p, things::PERMS_READ | things::PERMS_EXEC);
        Ok(match c {
            Color::Red => Color::Green,
            Color::Green => Color::Blue,
            Color::Blue => Color::Red,
        })
    }

    fn letter(&mut self, c: char) -> Result<char, Error> {
        Ok(c.to_ascii_uppercase())
    }

    fn text(&mut self, message: &[u8]) -> Result<Vec<u8>, Error> {
        Ok(message.to_ascii_uppercase())
    }

    fn bytes(&mut self, data: &[u8]) -> Result<Vec<u8>, Error> {
        Ok(data.iter().rev().copied().collect())
    }

    fn numbers(
        &mut self,
        values: Vec<i16>,
        wide: Vec<u64>,
        floats: Vec<f32>,
    ) -> Result<Vec<u32>, Error> {
        self.calls.push(format!("{values:?} {wide:?} {floats:?}"));
        Ok(vec![values.len() as u32, wide.len() as u32, 0xdead_beef])
    }

    fn points(&mut self, points: Vec<Point>) -> Result<Vec<Point>, Error> {
        Ok(points
            .into_iter()
            .map(|p| Point { x: p.y, y: p.x })
            .collect())
    }

    fn record_param(&mut self, p: Point, name: &[u8]) -> Result<Point, Error> {
        Ok(Point {
            x: p.x + name.len() as i32,
            y: p.y,
        })
    }

    fn tuples(&mut self, t: (u8, Vec<u8>, f32)) -> Result<(u32, Vec<u8>), Error> {
        Ok((u32::from(t.0) + t.2 as u32, t.1))
    }

    fn list_items(&mut self, path: &[u8]) -> Result<Listing, Error> {
        assert_eq!(path, b"/");
        Ok(Listing {
            status: -2,
            items: vec![
                Item {
                    name: b"one".to_vec(),
                    tag: vec![1],
                    color: Color::Blue,
                    weight: 1.5,
                    at: Point { x: 1, y: -1 },
                },
                Item {
                    name: Vec::new(),
                    tag: vec![2, 3],
                    color: Color::Red,
                    weight: -0.25,
                    at: Point { x: 2, y: -2 },
                },
            ],
            codes: vec![7, 65535],
        })
    }

    fn spilled(
        &mut self,
        a: u32,
        b: u32,
        c: u32,
        d: u32,
        e: u32,
        f: u32,
        g: u32,
        h: u32,
        i: &[u8],
        j: &[u8],
        k: &[u8],
        l: &[u8],
        m: u64,
        n: Point,
    ) -> Result<u32, Error> {
        let words = [a, b, c, d, e, f, g, h].iter().sum::<u32>();
        let text = [i, j, k, l].concat();
        assert_eq!(text, b"wxyz");
        assert_eq!(m, 1 << 40);
        Ok((words as i32 + n.x + n.y) as u32)
    }

    fn nothing(&mut self) -> Result<(), Error> {
        self.calls.push("nothing".into());
        Ok(())
    }
}

impl HostTest for Host {
    type Error = Error;

    fn shout(&mut self, word: &[u8]) -> Result<bool, Error> {
        Ok(word.ends_with(b"!"))
    }
}

fn call(
    host: &mut Host,
    memory: &mut Memory,
    name: &str,
    args: &[Flat],
) -> Result<Option<Flat>, Error> {
    things::call(host, memory, name, args).expect("an import of things")
}

#[test]
fn scalars_are_narrowed_and_widened() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    let args = [
        Flat::I32(7),
        Flat::I32(0x1ff),
        Flat::I32(0xffff_fff0),
        Flat::I32(0x1_0002),
        Flat::I32(0x8000),
        Flat::I32(u32::MAX),
        Flat::I32(u32::MAX),
        Flat::I64(u64::MAX),
        Flat::I64(u64::MAX),
        Flat::F32(0.5),
        Flat::F64(-2.0),
        Flat::I32('é' as u32),
    ];
    let result = call(&mut host, &mut memory, "scalars", &args);
    assert_eq!(result, Ok(Some(Flat::I64(u64::MAX - 1))));
    assert_eq!(
        host.calls,
        [format!(
            "true 255 -16 2 -32768 {} -1 {} -1 0.5 -2 é",
            u32::MAX,
            u64::MAX
        )]
    );
    let result = call(&mut host, &mut memory, "negate", &[Flat::I32(5)]);
    assert_eq!(result, Ok(Some(Flat::I32(-5i32 as u32))));
    let result = call(&mut host, &mut memory, "halve", &[Flat::F64(3.0)]);
    assert_eq!(result, Ok(Some(Flat::F64(1.5))));
    let result = call(&mut host, &mut memory, "letter", &[Flat::I32('q' as u32)]);
    assert_eq!(result, Ok(Some(Flat::I32('Q' as u32))));
    assert!(host.allocations.is_empty());
}

#[test]
fn enums_and_characters_out_of_range_trap() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    let perms = things::PERMS_READ | things::PERMS_EXEC;
    let result = call(
        &mut host,
        &mut memory,
        "enums",
        &[Flat::I32(2), Flat::I32(perms)],
    );
    assert_eq!(result, Ok(Some(Flat::I32(0))));
    let result = call(
        &mut host,
        &mut memory,
        "enums",
        &[Flat::I32(3), Flat::I32(perms)],
    );
    assert_eq!(result, Err(Error::Trap(Trap::InvalidValue)));
    let result = call(&mut host, &mut memory, "letter", &[Flat::I32(0xd800)]);
    assert_eq!(result, Err(Error::Trap(Trap::InvalidValue)));
}

#[test]
fn strings_go_out_through_the_allocator() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    memory.put(16, b"hello");
    let result = call(
        &mut host,
        &mut memory,
        "text",
        &[Flat::I32(16), Flat::I32(5), Flat::I32(64)],
    );
    assert_eq!(result, Ok(None));
    assert_eq!(host.allocations, [(1024, 1, 5)]);
    assert_eq!((memory.word(64), memory.word(68)), (1024, 5));
    assert_eq!(memory.get(1024, 5), b"HELLO");
    // An empty result allocates nothing and points at its alignment.
    let result = call(
        &mut host,
        &mut memory,
        "bytes",
        &[Flat::I32(16), Flat::I32(0), Flat::I32(64)],
    );
    assert_eq!(result, Ok(None));
    assert_eq!(host.allocations.len(), 1);
    assert_eq!((memory.word(64), memory.word(68)), (1, 0));
}

#[test]
fn lists_of_numbers_are_read_little_endian() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    memory.put(16, &[0xff, 0xff, 2, 0]);
    memory.put(32, &(1u64 << 33).to_le_bytes());
    memory.put(48, &1.5f32.to_le_bytes());
    let args = [
        Flat::I32(16),
        Flat::I32(2),
        Flat::I32(32),
        Flat::I32(1),
        Flat::I32(48),
        Flat::I32(1),
        Flat::I32(128),
    ];
    assert_eq!(call(&mut host, &mut memory, "numbers", &args), Ok(None));
    assert_eq!(host.calls, ["[-1, 2] [8589934592] [1.5]"]);
    assert_eq!(host.allocations, [(1024, 4, 12)]);
    assert_eq!((memory.word(128), memory.word(132)), (1024, 3));
    assert_eq!(memory.word(1032), 0xdead_beef);
    // A list must be aligned to its element.
    let mut args = args;
    args[2] = Flat::I32(33);
    assert_eq!(
        call(&mut host, &mut memory, "numbers", &args),
        Err(Error::Trap(Trap::Misaligned))
    );
    // And lie inside the memory.
    args[2] = Flat::I32(4088);
    args[3] = Flat::I32(2);
    assert_eq!(
        call(&mut host, &mut memory, "numbers", &args),
        Err(Error::OutOfBounds)
    );
}

#[test]
fn records_cross_both_ways() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    memory.put(
        16,
        &[1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff],
    );
    let result = call(
        &mut host,
        &mut memory,
        "points",
        &[Flat::I32(16), Flat::I32(2), Flat::I32(64)],
    );
    assert_eq!(result, Ok(None));
    assert_eq!(host.allocations, [(1024, 4, 16)]);
    assert_eq!(
        memory.get(1024, 16),
        [2, 0, 0, 0, 1, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff, 3, 0, 0, 0]
    );
    memory.put(200, b"abc");
    let args = [
        Flat::I32(10),
        Flat::I32(20),
        Flat::I32(200),
        Flat::I32(3),
        Flat::I32(96),
    ];
    assert_eq!(
        call(&mut host, &mut memory, "record-param", &args),
        Ok(None)
    );
    assert_eq!((memory.word(96), memory.word(100)), (13, 20));
    // The return area must be aligned to the result.
    let args = [
        Flat::I32(10),
        Flat::I32(20),
        Flat::I32(200),
        Flat::I32(3),
        Flat::I32(98),
    ];
    assert_eq!(
        call(&mut host, &mut memory, "record-param", &args),
        Err(Error::Trap(Trap::Misaligned))
    );
}

#[test]
fn tuples_cross_both_ways() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    memory.put(16, b"tuple");
    let args = [
        Flat::I32(3),
        Flat::I32(16),
        Flat::I32(5),
        Flat::F32(4.0),
        Flat::I32(64),
    ];
    assert_eq!(call(&mut host, &mut memory, "tuples", &args), Ok(None));
    assert_eq!(memory.word(64), 7);
    let (ptr, len) = (memory.word(68), memory.word(72));
    assert_eq!(memory.get(ptr, len), b"tuple");
}

#[test]
fn nested_results_allocate_outside_in() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    memory.put(16, b"/");
    let result = call(
        &mut host,
        &mut memory,
        "list-items",
        &[Flat::I32(16), Flat::I32(1), Flat::I32(64)],
    );
    assert_eq!(result, Ok(None));
    // The items' list first, then each item's strings and lists in order,
    // then the codes; the second item's empty name allocates nothing.
    assert_eq!(
        host.allocations,
        [
            (1024, 8, 80),
            (1104, 1, 3),
            (1107, 1, 1),
            (1108, 1, 2),
            (1110, 2, 4)
        ]
    );
    assert_eq!(memory.word(64), -2i32 as u32);
    assert_eq!((memory.word(68), memory.word(72)), (1024, 2));
    assert_eq!((memory.word(76), memory.word(80)), (1110, 2));
    let first = memory.get(1024, 40).to_vec();
    assert_eq!(&first[0..8], [80, 4, 0, 0, 3, 0, 0, 0]);
    assert_eq!(&first[8..16], [83, 4, 0, 0, 1, 0, 0, 0]);
    // The color, then zeroed padding up to the weight.
    assert_eq!(&first[16..24], [2, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(&first[24..32], 1.5f64.to_le_bytes());
    assert_eq!(&first[32..40], [1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    let second = memory.get(1064, 40).to_vec();
    assert_eq!(&second[0..8], [1, 0, 0, 0, 0, 0, 0, 0]);
    assert_eq!(memory.get(1104, 6), b"one\x01\x02\x03");
    assert_eq!(memory.get(1110, 4), [7, 0, 0xff, 0xff]);
}

#[test]
fn spilled_parameters_are_read_from_memory() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    let mut params = vec![0u8; 80];
    for index in 0..8 {
        params[index * 4..index * 4 + 4].copy_from_slice(&(index as u32 + 1).to_le_bytes());
    }
    memory.put(400, b"wxyz");
    for (index, at) in [32usize, 40, 48, 56].into_iter().enumerate() {
        params[at..at + 4].copy_from_slice(&(400 + index as u32).to_le_bytes());
        params[at + 4..at + 8].copy_from_slice(&1u32.to_le_bytes());
    }
    params[64..72].copy_from_slice(&(1u64 << 40).to_le_bytes());
    params[72..76].copy_from_slice(&100i32.to_le_bytes());
    params[76..80].copy_from_slice(&(-10i32).to_le_bytes());
    memory.put(512, &params);
    let result = call(&mut host, &mut memory, "spilled", &[Flat::I32(512)]);
    assert_eq!(result, Ok(Some(Flat::I32(36 + 90))));
    let result = call(&mut host, &mut memory, "spilled", &[Flat::I32(516)]);
    assert_eq!(result, Err(Error::Trap(Trap::Misaligned)));
}

#[test]
fn signatures_and_names_are_checked() {
    let (mut host, mut memory) = (Host::default(), Memory::new());
    assert_eq!(call(&mut host, &mut memory, "nothing", &[]), Ok(None));
    assert_eq!(host.calls, ["nothing"]);
    assert_eq!(
        call(&mut host, &mut memory, "negate", &[Flat::I64(1)]),
        Err(Error::Trap(Trap::Signature))
    );
    assert_eq!(
        call(&mut host, &mut memory, "nothing", &[Flat::I32(1)]),
        Err(Error::Trap(Trap::Signature))
    );
    assert!(things::call(&mut host, &mut memory, "shout", &[]).is_none());
    memory.put(16, b"hey!");
    let result = host_test::call(
        &mut host,
        &mut memory,
        "shout",
        &[Flat::I32(16), Flat::I32(4)],
    );
    assert_eq!(result, Some(Ok(Some(Flat::I32(1)))));
    assert_eq!(host_test::MODULE, "$root");
    assert_eq!(things::MODULE, "test:host/things@0.1.0");
    assert!(things::REALLOC.contains(&"list-items"));
    assert!(!things::MEMORY.contains(&"scalars"));
}
