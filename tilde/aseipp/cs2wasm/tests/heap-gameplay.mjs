// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Concrete end-to-end checks for the heap examples, shared by all test engines.
import { checker } from "./checker.mjs";

export const heapExamples = [
  ["ParticleSimulation", [3, 4], 3404],
  ["ParticleSimulation", [100, 20], 1678298650],
  ["SharedGraphWeight", [5], 15],
  ["MazeDistance", [6, 4], 14],
  ["AllocationPressure", [127], 16129],
];

export function checkHeapGameplay(exports, assert) {
  const heap = checker(exports, assert, "Demo.HeapGameplay.");
  const { expect } = heap;

  for (const [name, args, expected] of heapExamples) {
    expect(name, args, expected);
  }

  // These checksums are computed from the closed-form particle trajectories:
  // x(i,t) = i + t*(i+1), y(i,t) = -i + 2*t - t*(t+1)/2.
  for (
    const [count, steps, checksum] of [
      [0, 0, 0],
      [0, 10, 0],
      [1, 0, 0],
      [3, 0, 110],
      [1, 1, 20],
      [4, 10, 93538],
      [-1, 0, -1],
      [1, -1, -1],
    ]
  ) {
    expect("ParticleSimulation", [count, steps], checksum);
  }
  for (const bonus of [0, -4, 100]) {
    expect("SharedGraphWeight", [bonus], 10 + bonus);
  }

  // Distance from the start to every cell; -1 marks a wall. Fixed expected
  // distances check the whole maze without sharing the example's BFS code.
  const distances = [
    [0, 1, 2, -1, 8, 9, 10],
    [-1, -1, 3, -1, 7, -1, 11],
    [6, 5, 4, 5, 6, -1, 12],
    [7, -1, -1, -1, -1, -1, 13],
    [8, 9, 10, 11, 12, 13, 14],
  ];
  for (let y = 0; y < distances.length; y++) {
    for (let x = 0; x < distances[y].length; x++) {
      expect("MazeDistance", [x, y], distances[y][x]);
    }
  }
  for (
    const coordinates of [
      [-1, 0],
      [0, -1],
      [7, 0],
      [0, 5],
    ]
  ) {
    expect("MazeDistance", coordinates, -1);
  }
  for (const count of [0, 1, 10]) {
    expect("AllocationPressure", [count], count * count);
  }

  assert.throws(
    () => exports["Demo.HeapGameplay.AllocationPressure"](128),
    WebAssembly.RuntimeError,
    "allocation budget exhaustion",
  );
  heap.equal(exports.__fault.value, 3);
  expect("AllocationPressure", [1], 1);
  assert.equal(
    exports.__fault.value,
    0,
    "next export resets the fault and budgets",
  );
  return heap.checks;
}
