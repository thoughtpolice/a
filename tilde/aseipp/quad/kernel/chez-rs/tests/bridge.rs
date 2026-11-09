// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The bridge, end to end: Chez Scheme booted in this process calls Rust
//! procedures through the library chez::library! generates.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::testing::{boot, eval, eval_to_string};
use crate::{ByteVec, Bytes, Mailbox, Object, Ref, RefMut, Scope, Symbol, Value};

#[chez::procedure]
fn add(a: i64, b: i64) -> i64 {
    a + b
}

/// Greet someone.
///
/// By name.
#[chez::procedure]
fn greet(name: String) -> String {
    format!("hello, {name}")
}

#[chez::procedure]
fn sum_list(xs: Vec<i64>) -> i64 {
    xs.iter().sum()
}

#[chez::procedure]
fn reverse_bytes(data: Bytes) -> ByteVec {
    data.iter().rev().copied().collect::<Vec<_>>().into()
}

#[chez::procedure]
fn halve(x: Option<f64>) -> Option<f64> {
    x.map(|x| x / 2.0)
}

#[chez::procedure]
fn symbol_length(s: Symbol) -> usize {
    s.0.len()
}

#[chez::procedure(name = "fail!")]
fn fail(msg: String) -> Result<(), String> {
    Err(msg)
}

#[chez::procedure]
fn boom() -> i64 {
    panic!("kaboom")
}

#[chez::procedure]
fn pair_up<'s>(s: &'s Scope, a: Value<'s>, b: Value<'s>) -> Value<'s> {
    s.cons(a, b)
}

static DROPPED: AtomicUsize = AtomicUsize::new(0);

struct Counter(u64);

impl Drop for Counter {
    fn drop(&mut self) {
        DROPPED.fetch_add(1, Ordering::SeqCst);
    }
}

#[chez::procedure]
fn make_counter(start: u64) -> Object<Counter> {
    Object(Counter(start))
}

/// Count one more.
#[chez::procedure(name = "counter-bump!")]
fn counter_bump(mut c: RefMut<Counter>) -> u64 {
    c.0 += 1;
    c.0
}

#[chez::procedure]
fn counter_value(c: Ref<Counter>) -> u64 {
    c.0
}

#[chez::procedure]
fn counter_add(mut a: RefMut<Counter>, b: Ref<Counter>) -> u64 {
    a.0 += b.0;
    a.0
}

/// A mailbox a thread sends 1 to n into.
#[chez::procedure]
fn spawn_counting(n: u64) -> Object<Mailbox<u64>> {
    let (tx, mb) = Mailbox::new().unwrap();
    std::thread::spawn(move || {
        for i in 1..=n {
            let _ = tx.send(i);
        }
    });
    Object(mb)
}

#[chez::procedure]
fn mailbox_fd(m: Ref<Mailbox<u64>>) -> i32 {
    m.fd()
}

#[chez::procedure(name = "mailbox-take!")]
fn mailbox_take(m: Ref<Mailbox<u64>>) -> Vec<u64> {
    m.take()
}

chez::library! {
    fn test_library() -> "test native" {
        add, greet, sum_list, reverse_bytes, halve, symbol_length, fail, boom, pair_up,
        make_counter, counter_bump, counter_value, counter_add,
        spawn_counting, mailbox_fd, mailbox_take,
    }
}

/// The message of the error evaluating expr raises, or "no error".
fn error_of(expr: &str) -> String {
    let r = eval(&format!(
        "(guard (e [#t (condition-message e)]) {expr} \"no error\")"
    ));
    let s = unsafe { Scope::new() };
    r.get(&s).string().unwrap()
}

#[test]
fn bridge() {
    let petite = std::env::var("CHEZ_PETITE_BOOT").unwrap();
    let scheme = std::env::var("CHEZ_SCHEME_BOOT").unwrap();
    boot(&[&petite, &scheme]);
    crate::quiet_panics();
    test_library().register();
    eval(&std::fs::read_to_string(std::env::var("CHEZ_RUST_SLS").unwrap()).unwrap());
    let source = test_library().scheme_source();
    assert!(source.contains(";; Greet someone.\n  ;;\n  ;; By name.\n  (define-native greet \"test native:greet\" (name) #f)"), "{source}");
    assert!(source.contains("(define-native counter-bump! \"test native:counter-bump!\" (c) #f)"));
    assert!(
        source.contains("(define-native make-counter \"test native:make-counter\" (start) #t)")
    );
    eval(&source);
    eval("(import (test native) (chez rust))");

    // Conversions, both ways.
    assert_eq!(eval_to_string("(add 2 3)"), "5");
    assert_eq!(eval_to_string("(add (expt 2 40) -1)"), "1099511627775");
    assert_eq!(eval_to_string("(greet \"chez\")"), "\"hello, chez\"");
    assert_eq!(eval_to_string("(greet \"λ ünï\")"), "\"hello, λ ünï\"");
    assert_eq!(eval_to_string("(sum-list '(1 2 3 4))"), "10");
    assert_eq!(eval_to_string("(reverse-bytes #vu8(1 2 3))"), "#vu8(3 2 1)");
    assert_eq!(eval_to_string("(reverse-bytes #vu8())"), "#vu8()");
    assert_eq!(eval_to_string("(halve 3)"), "1.5");
    assert_eq!(eval_to_string("(halve #f)"), "#f");
    assert_eq!(eval_to_string("(symbol-length 'hello)"), "5");
    assert_eq!(eval_to_string("(pair-up 'a \"b\")"), "(a . \"b\")");

    // Errors name the argument, and raise in Scheme.
    assert_eq!(
        error_of("(add 1 \"x\")"),
        "argument 2 (b): expected an exact integer (i64), got \"x\""
    );
    assert_eq!(
        error_of("(add (expt 2 80) 1)"),
        format!("argument 1 (a): expected an exact integer (i64), got <bignum>")
    );
    assert_eq!(
        error_of("(sum-list '(1 two))"),
        "argument 1 (xs): element 1: expected an exact integer (i64), got two"
    );
    assert_eq!(error_of("(fail! \"no\")"), "no");
    assert_eq!(error_of("(boom)"), "Rust panicked: kaboom");
    assert_eq!(
        eval_to_string("(guard (e [#t (condition-who e)]) (boom))"),
        "boom"
    );
    // Arity is Scheme's to check.
    assert_eq!(eval_to_string("(guard (e [#t 'arity]) (add 1))"), "arity");

    // Rust objects.
    eval("(define c (make-counter 10))");
    assert_eq!(eval_to_string("(native-object? c)"), "#t");
    assert_eq!(
        eval_to_string("(list (counter-bump! c) (counter-bump! c) (counter-value c))"),
        "(11 12 12)"
    );
    eval("(define d (make-counter 5))");
    assert_eq!(eval_to_string("(counter-add c d)"), "17");
    // Borrowing one object twice, mutably, is an error, not aliasing.
    assert!(error_of("(counter-add c c)").contains("is borrowed mutably"));
    assert!(
        error_of("(counter-value 42)").contains("expected a chez::bridge_tests::Counter object")
    );
    assert!(error_of("(counter-value (spawn-counting 0))").contains("Counter object"));
    // A pair made by hand to look like a handle is not one.
    assert!(
        error_of("(counter-value (cons 'chez::bridge_tests::Counter 12345))")
            .contains("Counter object")
    );
    let before = DROPPED.load(Ordering::SeqCst);
    eval("(native-drop! c)");
    assert_eq!(DROPPED.load(Ordering::SeqCst), before + 1);
    assert!(error_of("(counter-value c)").contains("has been dropped"));
    eval("(native-drop! c)"); // twice is fine

    // Unreferenced objects are dropped by the guardian.
    let before = DROPPED.load(Ordering::SeqCst);
    eval("(do ([i 0 (+ i 1)]) ((= i 100)) (make-counter i))");
    eval("(collect (collect-maximum-generation)) (native-drop-unreferenced!)");
    assert!(
        DROPPED.load(Ordering::SeqCst) >= before + 100,
        "{} dropped",
        DROPPED.load(Ordering::SeqCst) - before
    );

    // A thread's values reach Scheme through a mailbox.
    eval("(define m (spawn-counting 5))");
    assert_eq!(
        eval_to_string(
            "(let loop ([got '()] [tries 0])
               (if (or (= (length got) 5) (= tries 1000))
                   got
                   (begin (sleep (make-time 'time-duration 1000000 0))
                          (loop (append got (mailbox-take! m)) (+ tries 1)))))"
        ),
        "(1 2 3 4 5)"
    );
    assert_eq!(eval_to_string("(>= (mailbox-fd m) 0)"), "#t");
}
