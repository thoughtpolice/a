# SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
# SPDX-License-Identifier: MIT

load("@root//buck/shims:shims.bzl", "shims")
load("@root//buck/shims:package.bzl", "pkg")

VERSION = pkg.version()

shims.http_archive(
    name="src",
    sha256="4e917eea3bb6051a0551fdd3aac45199ff705fa08920c15b824a08c5fbb032e4",
    urls=[
        f"https://github.com/quickjs-ng/quickjs/archive/refs/tags/v{VERSION}.tar.gz",
    ],
    type="tar.gz",
    strip_prefix=f"quickjs-{VERSION}",
    sub_targets=[
        # Core library sources
        "quickjs.c",
        "libregexp.c",
        "libunicode.c",
        "cutils.c",
        "xsum.c",
        # Headers
        "quickjs.h",
        "quickjs-libc.h",
        "cutils.h",
        "libregexp.h",
        "libunicode.h",
        "libregexp-opcode.h",
        "libunicode-table.h",
        "list.h",
        "quickjs-atom.h",
        "quickjs-opcode.h",
        "xsum.h",
        # Executables
        "qjs.c",
        "qjsc.c",
        "quickjs-libc.c",
        # Additional files
        "repl.js",
        "standalone.js",
        # Pre-generated files
        "gen/repl.c",
        "gen/standalone.c",
    ],
)

# Common build flags from build.zig
COMMON_FLAGS = [
    "-funsigned-char",
    "-fwrapv",
    "-Wno-implicit-fallthrough",
    "-Wno-sign-compare",
    "-Wno-missing-field-initializers",
    "-Wno-unused-parameter",
    "-Wno-unused-but-set-variable",
    "-Wno-array-bounds",
    "-Wno-format-truncation",
]

# Core defines
CORE_DEFINES = [
    "_GNU_SOURCE=1",
]

# Core QuickJS library
shims.cxx_library(
    name="quickjs",
    srcs=[
        ":src[quickjs.c]",
        ":src[libregexp.c]",
        ":src[libunicode.c]",
        ":src[cutils.c]",
        ":src[xsum.c]",
    ],
    headers=[
        ":src[cutils.h]",
        ":src[libregexp.h]",
        ":src[libunicode.h]",
        ":src[libregexp-opcode.h]",
        ":src[libunicode-table.h]",
        ":src[list.h]",
        ":src[quickjs-atom.h]",
        ":src[quickjs-opcode.h]",
        ":src[xsum.h]",
    ],
    header_namespace="",
    exported_headers={
        "quickjs.h": ":src[quickjs.h]",
        "quickjs-libc.h": ":src[quickjs-libc.h]",
    },
    preferred_linkage="static",
    compiler_flags=COMMON_FLAGS,
    preprocessor_flags=map(lambda x: f"-D{x}", CORE_DEFINES),
)

# QuickJS libc support library
shims.cxx_library(
    name="quickjs-libc",
    srcs=[":src[quickjs-libc.c]"],
    headers=[":src[cutils.h]"],
    header_namespace="",
    deps=[":quickjs"],
    preferred_linkage="static",
    compiler_flags=COMMON_FLAGS,
    preprocessor_flags=map(lambda x: f"-D{x}", CORE_DEFINES),
)

# QJSC compiler
shims.cxx_binary(
    name="qjsc",
    srcs=[":src[qjsc.c]"],
    headers=[":src[cutils.h]"],
    deps=[
        ":quickjs",
        ":quickjs-libc",
    ],
    compiler_flags=COMMON_FLAGS,
    preprocessor_flags=map(lambda x: f"-D{x}", CORE_DEFINES),
)

# QJS interpreter
shims.cxx_binary(
    name="qjs",
    srcs=[
        ":src[qjs.c]",
        ":src[gen/repl.c]",
        ":src[gen/standalone.c]",
    ],
    headers=[":src[cutils.h]"],
    deps=[
        ":quickjs",
        ":quickjs-libc",
    ],
    compiler_flags=COMMON_FLAGS,
    preprocessor_flags=map(lambda x: f"-D{x}", CORE_DEFINES),
)

# Default target alias that includes tests
shims.alias(
    name="quickjs-ng",
    actual=":qjs",
    visibility=["PUBLIC"],
)

# Test: Basic JavaScript execution
shims.command_test(
    name="test-basic-js",
    cmd=["$(exe :qjs)", "-e", "if (1 + 1 !== 2) throw new Error('Basic math failed'); console.log('Basic math OK')"],
)

# Test: Console output (only console.log exists in QuickJS)
shims.command_test(
    name="test-console",
    cmd=["$(exe :qjs)", "-e", "console.log('test'); console.log('warning'); console.log('error')"],
)

# Test: JSON functionality
shims.command_test(
    name="test-json",
    cmd=["$(exe :qjs)", "-e", """const obj = { a: 1, b: 'test', c: [1, 2, 3] };
const json = JSON.stringify(obj);
const parsed = JSON.parse(json);
if (parsed.a !== 1 || parsed.b !== 'test' || parsed.c.length !== 3) {
    throw new Error('JSON test failed');
}
console.log('JSON test passed');"""],
)

# Test: Array methods
shims.command_test(
    name="test-arrays",
    cmd=["$(exe :qjs)", "-e", """const arr = [1, 2, 3, 4, 5];
const doubled = arr.map(x => x * 2);
const sum = arr.reduce((a, b) => a + b, 0);
const filtered = arr.filter(x => x > 2);
if (doubled[2] !== 6 || sum !== 15 || filtered.length !== 3) {
    throw new Error('Array test failed');
}
console.log('Array methods OK');"""],
)

# Test: Promise functionality
shims.command_test(
    name="test-promises",
    cmd=["$(exe :qjs)", "-e", """Promise.resolve(42)
    .then(x => x * 2)
    .then(x => {
        if (x !== 84) throw new Error('Promise test failed');
        console.log('Promise test passed');
    })
    .catch(e => {
        console.error(e);
        throw e;
    });"""],
)

# Test: BigInt support
shims.command_test(
    name="test-bigint",
    cmd=["$(exe :qjs)", "-e", """const big1 = 123456789012345678901234567890n;
const big2 = 987654321098765432109876543210n;
const sum = big1 + big2;
if (typeof sum !== 'bigint') {
    throw new Error('BigInt test failed');
}
console.log('BigInt support OK');"""],
)

# Test: Error handling
shims.command_test(
    name="test-errors",
    cmd=["$(exe :qjs)", "-e", """try {
    throw new Error('Test error');
} catch (e) {
    if (e.message !== 'Test error') {
        throw new Error('Error handling failed');
    }
}
console.log('Error handling OK');"""],
)

# Test: Regular expressions
shims.command_test(
    name="test-regex",
    cmd=["$(exe :qjs)", "-e", """const regex = /^[a-z]+@[a-z]+\\.[a-z]+$/;
if (!regex.test('test@example.com')) {
    throw new Error('Regex test failed');
}
if (regex.test('invalid-email')) {
    throw new Error('Regex test failed');
}
console.log('Regex support OK');"""],
)

# Test: Object operations
shims.command_test(
    name="test-objects",
    cmd=["$(exe :qjs)", "-e", """const obj = { a: 1, b: 2 };
const keys = Object.keys(obj);
const values = Object.values(obj);
const entries = Object.entries(obj);
if (keys.length !== 2 || values[0] !== 1 || entries[1][1] !== 2) {
    throw new Error('Object operations failed');
}
console.log('Object operations OK');"""],
)

# Test: String methods
shims.command_test(
    name="test-strings",
    cmd=["$(exe :qjs)", "-e", """const str = 'Hello, World!';
if (!str.startsWith('Hello') || !str.endsWith('!') || !str.includes('World')) {
    throw new Error('String methods failed');
}
const trimmed = '  test  '.trim();
if (trimmed !== 'test') {
    throw new Error('String trim failed');
}
console.log('String methods OK');"""],
)

# Test: Math functions
shims.command_test(
    name="test-math",
    cmd=["$(exe :qjs)", "-e", """const tests = [
    Math.abs(-5) === 5,
    Math.ceil(4.3) === 5,
    Math.floor(4.7) === 4,
    Math.round(4.5) === 5,
    Math.max(1, 2, 3) === 3,
    Math.min(1, 2, 3) === 1,
    Math.sqrt(16) === 4,
    Math.pow(2, 3) === 8
];
if (!tests.every(t => t)) {
    throw new Error('Math functions failed');
}
console.log('Math functions OK');"""],
)

# Test: Date functionality
shims.command_test(
    name="test-date",
    cmd=["$(exe :qjs)", "-e", """const date = new Date(2024, 0, 1);
if (date.getFullYear() !== 2024 || date.getMonth() !== 0 || date.getDate() !== 1) {
    throw new Error('Date test failed');
}
console.log('Date functionality OK');"""],
)

# Test: Set and Map
shims.command_test(
    name="test-collections",
    cmd=["$(exe :qjs)", "-e", """const set = new Set([1, 2, 3, 3, 4]);
const map = new Map([['a', 1], ['b', 2]]);
if (set.size !== 4 || !set.has(3)) {
    throw new Error('Set test failed');
}
if (map.size !== 2 || map.get('a') !== 1) {
    throw new Error('Map test failed');
}
console.log('Set and Map OK');"""],
)

# Test: Template literals
shims.command_test(
    name="test-template-literals",
    cmd=["$(exe :qjs)", "-e", """const name = 'World';
const greeting = `Hello, ${name}!`;
if (greeting !== 'Hello, World!') {
    throw new Error('Template literal failed');
}
console.log('Template literals OK');"""],
)

# Test: Destructuring
shims.command_test(
    name="test-destructuring",
    cmd=["$(exe :qjs)", "-e", """const [a, b, ...rest] = [1, 2, 3, 4, 5];
const { x, y } = { x: 10, y: 20 };
if (a !== 1 || b !== 2 || rest.length !== 3 || x !== 10 || y !== 20) {
    throw new Error('Destructuring failed');
}
console.log('Destructuring OK');"""],
)

# Test: Arrow functions
shims.command_test(
    name="test-arrow-functions",
    cmd=["$(exe :qjs)", "-e", """const add = (a, b) => a + b;
const multiply = x => x * 2;
if (add(1, 2) !== 3 || multiply(5) !== 10) {
    throw new Error('Arrow functions failed');
}
console.log('Arrow functions OK');"""],
)

# Test: Classes
shims.command_test(
    name="test-classes",
    cmd=["$(exe :qjs)", "-e", """class Animal {
    constructor(name) {
        this.name = name;
    }
    speak() {
        return `${this.name} makes a sound`;
    }
}
class Dog extends Animal {
    speak() {
        return `${this.name} barks`;
    }
}
const dog = new Dog('Rex');
if (dog.speak() !== 'Rex barks') {
    throw new Error('Classes test failed');
}
console.log('Classes OK');"""],
)

# Test: Async/await
shims.command_test(
    name="test-async-await",
    cmd=["$(exe :qjs)", "-e", """async function test() {
    const result = await Promise.resolve(42);
    if (result !== 42) {
        throw new Error('Async/await failed');
    }
    console.log('Async/await OK');
}
test().catch(e => { console.error(e); process.exit(1); });"""],
)

# Test: Spread operator
shims.command_test(
    name="test-spread",
    cmd=["$(exe :qjs)", "-e", """const arr1 = [1, 2, 3];
const arr2 = [...arr1, 4, 5];
const obj1 = { a: 1, b: 2 };
const obj2 = { ...obj1, c: 3 };
if (arr2.length !== 5 || obj2.c !== 3) {
    throw new Error('Spread operator failed');
}
console.log('Spread operator OK');"""],
)

# Test: Symbol
shims.command_test(
    name="test-symbol",
    cmd=["$(exe :qjs)", "-e", """const sym = Symbol('test');
const obj = { [sym]: 'value' };
if (obj[sym] !== 'value' || typeof sym !== 'symbol') {
    throw new Error('Symbol test failed');
}
console.log('Symbol support OK');"""],
)

# Aggregate all tests
shims.test_suite(
    name="tests",
    tests=[
        ":test-basic-js",
        ":test-console",
        ":test-json",
        ":test-arrays",
        ":test-promises",
        ":test-bigint",
        ":test-errors",
        ":test-regex",
        ":test-objects",
        ":test-strings",
        ":test-math",
        ":test-date",
        ":test-collections",
        ":test-template-literals",
        ":test-destructuring",
        ":test-arrow-functions",
        ":test-classes",
        ":test-async-await",
        ":test-spread",
        ":test-symbol",
    ],
)
