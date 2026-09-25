// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  ContainerController,
  ContainerError,
  type ContainerErrorCode,
  type ContainerHooks,
  type ContainerOptions,
  type StopEvent,
} from "@celld/container";
import {
  FakeContainer,
  type FakeContainerOptions,
  FakeState,
  ManualClock,
} from "@celld/container/testing";

/** Hook calls, in order, as short strings. */
export interface Recorded {
  readonly events: string[];
  readonly stops: StopEvent[];
  readonly hooks: ContainerHooks;
}

export function recorder(): Recorded {
  const events: string[] = [];
  const stops: StopEvent[] = [];
  return {
    events,
    stops,
    hooks: {
      onStart: () => {
        events.push("start");
      },
      onStop: (event) => {
        events.push(`stop:${event.reason}`);
        stops.push(event);
      },
      onError: (error) => {
        events.push(`error:${ContainerError.from(error)?.code ?? "other"}`);
      },
    },
  };
}

export interface Setup {
  readonly container: FakeContainer;
  readonly state: FakeState;
  readonly clock: ManualClock;
  readonly controller: ContainerController;
  readonly recorded: Recorded;
}

export function setup(
  options: ContainerOptions = {},
  fake: FakeContainerOptions = {},
  hooks?: ContainerHooks,
): Setup {
  const container = new FakeContainer(fake);
  const state = new FakeState(container);
  const clock = new ManualClock();
  const recorded = recorder();
  const controller = new ContainerController(
    state,
    options,
    hooks ?? recorded.hooks,
    clock,
  );
  return { container, state, clock, controller, recorded };
}

/** Awaits `promise` and checks it rejects with a ContainerError of `code`. */
export async function rejectsWith(
  promise: Promise<unknown>,
  code: ContainerErrorCode,
): Promise<ContainerError> {
  try {
    await promise;
  } catch (error) {
    const found = ContainerError.from(error);
    if (found === null || found.code !== code) {
      throw new Error(`expected [${code}], got ${String(error)}`);
    }
    return found;
  }
  throw new Error(`expected [${code}], but it succeeded`);
}
