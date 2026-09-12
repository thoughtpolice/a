// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// tests/Frames.cs: the frame loop where it has no CLR
// counterpart, one instance through a sequence of frames.
export function checkFrames(module, assert) {
  let checks = 0;
  const { exports } = new WebAssembly.Instance(module, {});
  const call = (name, ...args) =>
    exports[`Tests.Loop.FrameLoop.${name}`](...args);
  function equal(actual, expected, message) {
    assert.equal(actual, expected, message);
    checks++;
  }
  function faults(name, fault, message) {
    assert.throws(() => call(name), WebAssembly.RuntimeError, message);
    equal(exports.__fault.value, fault, message);
  }
  const frame = (milliseconds) => call("Frame", milliseconds);
  const read = () => call("Read");

  // Task.Delay counts game time: those due together in the order they
  // started, a delay of 0 at once.
  equal(call("Delays"), 1, "a delay of 0 completes at once");
  equal(read(), 4, "the delay of 0");
  frame(10);
  equal(read(), 0, "nothing is due at 10 ms");
  frame(10);
  equal(read(), 2, "the 20 ms delay");
  frame(29);
  equal(read(), 0, "nothing is due at 49 ms");
  frame(1);
  equal(read(), 13, "the 50 ms delays, in the order they started");
  equal(call("Count"), 4n, "four frames");
  equal(call("Time"), 50n, "50 ms of game time");

  // CancelAfter and a delayed CancellationTokenSource: the callbacks the
  // last registered first, the canceled delay's synchronous continuation.
  call("Cancels");
  frame(29);
  equal(read(), 0, "nothing is canceled before 30 ms");
  frame(1);
  equal(read(), 65, "CancelAfter cancels the delay, then the callback");
  frame(10);
  equal(read(), 8, "the source canceled after 40 ms");

  // A timeout: WhenAny against a delay.
  call("Timeouts");
  frame(10);
  equal(read(), 1, "the work first");
  frame(20);
  equal(read(), 2, "the timeout first");

  // With no context current, the continuation goes to the queue and runs
  // with none current.
  call("Unposted");
  equal(read(), 12, "the method returned at its yield");
  frame(0);
  equal(read(), 3, "the continuation ran with no context");

  // ConfigureAwait(false) and ContinueWith: queued after the frame's own
  // continuation, ContinueWith's first, as dotnet/runtime runs them.
  call("Unscheduled");
  frame(0);
  equal(read(), 1275, "queued continuations run after the frame's");

  // A wait that would block the only thread.
  faults("Blocks", 20, "Task<T>.Result of an incomplete task");
  faults("Waits", 20, "Task.Wait of an incomplete task");
  faults("GetsResult", 20, "GetAwaiter().GetResult() of an incomplete task");

  // An async void method's exception escapes the frame, which ends; the
  // loop runs the next.
  call("Explodes");
  assert.throws(() => frame(0), WebAssembly.RuntimeError, "the frame ends");
  equal(exports.__fault.value, 17, "with the exception's fault");
  equal(read(), 9, "the method ran up to its throw");
  call("Walks");
  for (let expected = 1; expected <= 3; expected++) {
    equal(call("PendingDone"), 0, `walking before frame ${expected}`);
    frame(16);
    equal(read(), expected, `a step each frame (${expected})`);
  }
  equal(call("PendingDone"), 1, "the walk completed");

  // A chain of 300 awaits completing one another inline would exceed the
  // call depth; past three quarters of it they go on from the queue.
  equal(call("Chains"), 0, "the chain is not done within the call");
  frame(0);
  equal(call("Chained"), 300, "the frame finishes it");

  // WaitAsync times out in game time.
  call("WaitsAsync");
  equal(read(), 7, "a task done before the timeout completes its wait");
  frame(29);
  equal(call("Waited"), 0, "nothing at 29 ms");
  frame(1);
  equal(call("Waited"), 1, "a TimeoutException at 30 ms");

  // Task.Run queues to the frame loop; a wait runs a queued task itself.
  equal(call("Runs"), 0, "Task.Run's task waits for the queue");
  equal(read(), 2, "Result ran its task inline");
  frame(0);
  equal(read(), 134, "the queue ran the rest in order");
  equal(call("PendingDone"), 1, "the async function's task, unwrapped");

  // The queue runs in the default ExecutionContext or the one work flows.
  equal(call("Pools"), 5, "the caller keeps its own");
  frame(0);
  equal(read(), 1234, "flowed contexts, and the default for the unsafe");

  // Continuations run under the frame's budget: one that never stops
  // yielding exhausts its fuel.
  call("Spins");
  assert.throws(() => frame(0), WebAssembly.RuntimeError, "the frame runs out");
  equal(exports.__fault.value, 1, "of fuel");
  return checks;
}
