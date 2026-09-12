// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Own the instance here so Node, SpiderMonkey, and optimized modules exercise
// the same host callbacks and stateful expectations.
export function checkHostImports(module, assert) {
  let checks = 0;
  function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    checks++;
  }
  function equalList(actual, expected, message) {
    equal(JSON.stringify(actual), JSON.stringify(expected), message);
  }

  equalList(
    WebAssembly.Module.imports(module).map(({ module, name, kind }) => [
      module,
      name,
      kind,
    ]),
    [
      ["test", "trace", "function"],
      ["test", "flag", "function"],
      ["test", "mix", "function"],
      ["test", "float-sample-🎮", "function"],
      ["test", "notify", "function"],
    ],
    "typed host import descriptors",
  );
  equal(
    WebAssembly.Module.exports(module).filter(({ name }) =>
      name.startsWith("Tests.HostApi.")
    ).length,
    0,
    "host import declarations are not exported",
  );
  assert.throws(
    () => new WebAssembly.Instance(module, { test: {} }),
    WebAssembly.LinkError,
    "all declared capabilities must be supplied",
  );
  checks++;

  const trace = [];
  const mixedCalls = [];
  const notifications = [];
  const hostError = new Error("host trace failed");
  let failAt = -1;
  let flag = 7;
  let traceOffset = 0;
  const { exports } = new WebAssembly.Instance(module, {
    test: {
      trace(value) {
        trace.push(value);
        if (value === failAt) {
          throw hostError;
        }
        return value + traceOffset;
      },
      flag() {
        return flag;
      },
      mix(value, enabled, scale, offset) {
        mixedCalls.push([value, enabled, scale, offset]);
        return value + enabled * 100 + scale * 10 + offset;
      },
      "float-sample-🎮"() {
        return 1 / 3;
      },
      notify(value) {
        notifications.push(value);
      },
    },
  });
  function invoke(name, ...args) {
    return exports["Tests.HostImports." + name](...args);
  }

  equal(invoke("ConstructionOrder"), 23145, "constructor and helper indexes");
  equalList(
    trace,
    [1, 2, 3, 4, 5],
    "argument, fields, body, object initializer",
  );
  trace.length = 0;
  equal(invoke("ImplicitInitializer"), 6, "implicit constructor calls host");
  equalList(trace, [6], "implicit initializer executes once");

  for (
    const [hostValue, expected] of [
      [7, 1],
      [0, 0],
      [-9, 1],
    ]
  ) {
    flag = hostValue;
    equal(invoke("HostFlag"), expected, "imported bool result normalization");
  }

  equal(invoke("MixedAbi", 12, 7, 1.25, 0.125), 124.625, "mixed primitive ABI");
  equalList(mixedCalls.pop(), [12, 1, 1.25, 0.125], "canonical bool argument");
  const scale = Math.fround(1.23456789);
  equal(
    invoke("MixedAbi", -12, 0, 1.23456789, 0.0625),
    -12 + scale * 10 + 0.0625,
    "f32 argument rounding and double result",
  );
  equalList(mixedCalls.pop(), [-12, 0, scale, 0.0625], "mixed argument order");

  flag = 7;
  equal(invoke("ForwardHostFlag"), 115, "host bool forwarded to host");
  equalList(mixedCalls.pop(), [2, 1, 1.25, 0.5], "forwarded bool is canonical");
  trace.length = 0;
  equal(invoke("NamedArgumentOrder"), 124, "named host arguments");
  equalList(trace, [1, 2, 3], "named arguments evaluate in source order");
  equalList(
    mixedCalls.pop(),
    [3, 1, 2, 1],
    "named arguments bind in parameter order",
  );
  equal(invoke("FloatResult"), Math.fround(1 / 3), "f32 host result rounding");
  traceOffset = 0.75;
  equal(invoke("IntegerResult", 8), 8, "i32 host result conversion");
  traceOffset = 0;
  equal(invoke("Send", 42), undefined, "void host call");
  equalList(notifications, [42], "host command received once");

  trace.length = 0;
  failAt = 2;
  assert.throws(
    () => invoke("ConstructionOrder"),
    Error,
    "host exception escapes field initializer",
  );
  checks++;
  equalList(trace, [1, 2], "host exception stops subsequent initializers");
  equal(
    exports.__fault.value,
    0,
    "host exceptions do not invent a compiler fault",
  );
  failAt = -1;
  trace.length = 0;
  equal(
    invoke("ConstructionOrder"),
    23145,
    "entry recovers after host exception",
  );
  equalList(
    trace,
    [1, 2, 3, 4, 5],
    "recovered call executes all initialization",
  );
  equal(exports.__fault.value, 0, "successful host entry has no fault");
  return checks;
}
