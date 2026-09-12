// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs), except for the
// default messages, which are the module's own (see README.md).
import { checker } from "./checker.mjs";

// Messages.Digest, over a string's UTF-16 code units.
function digest(text) {
  let value = text.length;
  for (let index = 0; index < text.length; index++) {
    value = (Math.imul(value, 31) + text.charCodeAt(index)) | 0;
  }
  return value;
}

export function checkMessages(exports, assert) {
  const messages = checker(
    exports,
    assert,
    "Tests.ExceptionMessages.Messages.",
  );
  const { expect, trap } = messages;

  expect("UserMessage", [42], -77057727);
  expect("UserMessage", [-5], -77057988);
  expect("Inner", [1], -208173248);
  expect("Wrapped", [42], 1743309266);
  expect("FrameworkMessage", [0], -404549715);
  expect("FrameworkMessage", [2], -909737978);
  expect("FrameworkMessage", [3], 0);
  expect("NullMessageKeepsDefault", [], 111);
  trap("NullReceiver", [], 5);
  expect("TypeInitialization", [], 74129625);
  // Without a message, an exception says what its class is, as the CLR
  // says it for classes without a default message of their own; the checks'
  // exceptions have their classes' own, the CLR's text.
  expect(
    "DefaultMessage",
    [0],
    digest("Exception of type 'Tests.ExceptionMessages.Plain' was thrown."),
  );
  expect(
    "DefaultMessage",
    [1],
    digest("Index was outside the bounds of the array."),
  );
  expect(
    "TypeInitializationMessage",
    [],
    digest(
      "The type initializer for 'Tests.ExceptionMessages.Broken' threw an exception.",
    ),
  );
  return messages.checks;
}
