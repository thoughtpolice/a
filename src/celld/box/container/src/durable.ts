// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `Container`: a Durable Object base class that owns one container, in the
 * shape of Cloudflare's `@cloudflare/containers`.
 *
 * ```ts
 * import { Container, getContainer } from "@celld/box/container/durable";
 *
 * export class Api extends Container {
 *   override defaultPort = 8080;
 *   override sleepAfter = "5m";
 *   override envVars = { MODE: "production" };
 *
 *   override onStart() {
 *     console.log("container up");
 *   }
 * }
 *
 * export default {
 *   fetch: (request: Request, env: { API: DurableObjectNamespace<Api> }) =>
 *     getContainer(env.API, "main").fetch(request),
 * };
 * ```
 *
 * `fetch` always goes to `defaultPort`: whoever can send the object a
 * request reaches that port and no other. It removes any
 * `x-celld-container-port` header rather than obeying it, so a Worker may
 * forward public requests unchanged. Every other header (`Authorization`,
 * `Cookie` and any other credential) and the body, unbounded, reach the
 * container untouched: the service in it authenticates its callers
 * itself, and a Worker that holds its own credentials or must bound what
 * reaches the container strips those headers and caps the body before it
 * forwards. An error is answered as JSON `{error, message}`: `400` for a
 * bad port, `503` with a fixed message for the rest (set `unsafeDetail` to
 * see the engine's detail). Another port is the Worker's
 * decision, made in code with the RPC method `fetchPort(request, port)`;
 * never derive that port from the request without checking it against
 * what the caller may reach.
 *
 * ```python
 * celld.project(
 *     ...,
 *     bindings = {"API": "Api"},
 *     container_context = ":image",
 *     containers = [{"class_name": "Api", "image": "container/Dockerfile"}],
 * )
 * ```
 *
 * Configuration is class fields, read once when the object first needs its
 * controller. A subclass that defines its own `alarm()` must call
 * `super.alarm()`: the one Durable Object alarm drives idle sleep.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  checkPort,
  ContainerController,
  type WaitForPortOptions,
} from "./controller.ts";
import type { Duration } from "./duration.ts";
import { ContainerError } from "./errors.ts";
import { uniformIndex } from "./random.ts";
import type {
  ContainerState,
  RestartPolicy,
  StartOverrides,
  StopEvent,
} from "./types.ts";

/**
 * A control header `Container.fetch` removes from every request and never
 * obeys. Earlier versions chose the port from it, which let anyone who could
 * reach a forwarding Worker pick any listening port.
 */
export const PORT_HEADER = "x-celld-container-port";

/** The RPC surface of a {@link Container}, for typing namespaces and stubs. */
export interface ContainerApi {
  start(overrides?: StartOverrides): Promise<void>;
  startAndWaitForPorts(
    overrides?: StartOverrides,
    ports?: number[],
  ): Promise<void>;
  waitForPort(port: number, options?: WaitForPortOptions): Promise<void>;
  stop(signal?: number): Promise<void>;
  destroy(): Promise<void>;
  getState(): ContainerState;
  renewActivityTimeout(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  fetchPort(request: Request, port: number): Promise<Response>;
}

/** See the module documentation. */
export class Container<Env = unknown> extends DurableObject<Env>
  implements ContainerApi {
  /** The port `fetch` forwards to. */
  defaultPort?: number;
  /** Ports that must accept connections before the container is healthy. */
  requiredPorts?: number[];
  /** HTTP path probed while waiting for ports; a TCP connect when unset. */
  pingPath?: string;
  /** Idle time before the container is stopped (a string: `"10m"`, `"PT1H"`). */
  sleepAfter: Duration = "10m";
  /** Environment for every start. */
  envVars: Record<string, string> = {};
  /** Overrides the image's entrypoint and command. */
  entrypoint?: string[];
  /** Fenced Internet egress; off unless set. */
  enableInternet = false;
  /** Engine labels for every start. */
  labels: Record<string, string> = {};
  /** What to do when the container is found dead; see `RestartMode`. */
  restartPolicy: Partial<RestartPolicy> = {};
  startTimeout: Duration = "30s";
  portTimeout: Duration = "30s";
  stopGrace: Duration = "5s";
  /**
   * Put the error's detail in the JSON answers of `fetch` and `fetchPort`
   * (default false). The detail is the engine's start error, the last
   * error, ports and timing: for the container's owner, not for whoever
   * sends a forwarded public request, which gets the code and a fixed text.
   */
  unsafeDetail = false;

  #controller: ContainerController | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** The lifecycle controller, built from the class fields on first use. */
  protected get controller(): ContainerController {
    if (typeof this.unsafeDetail !== "boolean") {
      throw new ContainerError("invalid", "unsafeDetail must be boolean");
    }
    this.#controller ??= new ContainerController(
      this.ctx,
      {
        defaultPort: this.defaultPort,
        requiredPorts: this.requiredPorts,
        pingPath: this.pingPath,
        sleepAfter: this.sleepAfter,
        envVars: this.envVars,
        entrypoint: this.entrypoint,
        enableInternet: this.enableInternet,
        labels: this.labels,
        restart: this.restartPolicy,
        startTimeout: this.startTimeout,
        portTimeout: this.portTimeout,
        stopGrace: this.stopGrace,
      },
      {
        onStart: () => this.onStart(),
        onStop: (event) => this.onStop(event),
        onError: (error) => this.onError(error),
        ...(this.onActivityExpired === Container.prototype.onActivityExpired
          ? {}
          : { onActivityExpired: () => this.onActivityExpired() }),
      },
    );
    return this.#controller;
  }

  /** Runs after every start, once the required ports answer. */
  onStart(): void | Promise<void> {}

  /** Runs after the container stops for any reason, crashes included. */
  onStop(_event: StopEvent): void | Promise<void> {}

  /** Runs when a start fails or a crash is noticed. */
  onError(_error: unknown): void | Promise<void> {}

  /** Runs when `sleepAfter` elapses; the default stops the container. */
  async onActivityExpired(): Promise<void> {
    await this.controller.stop("sleep");
  }

  /** Starts the container, waiting for the required ports. */
  async start(overrides?: StartOverrides): Promise<void> {
    await this.controller.start(overrides);
  }

  /** Starts the container and waits for `ports` (default: required or default port). */
  async startAndWaitForPorts(
    overrides?: StartOverrides,
    ports?: number[],
  ): Promise<void> {
    await this.controller.startAndWaitForPorts(overrides, ports);
  }

  /** Waits for a port of the running container to accept connections. */
  async waitForPort(port: number, options?: WaitForPortOptions): Promise<void> {
    await this.controller.waitForPort(port, options);
  }

  /** Sends `signal` (default SIGTERM), then destroys after the grace period. */
  async stop(signal = 15): Promise<void> {
    await this.controller.stop("stop", signal);
  }

  /**
   * Kills the container at once. A subclass that keeps state tied to the
   * container (such as `Sandbox`) may widen this to clear it too.
   */
  async destroy(): Promise<void> {
    await this.controller.destroy();
  }

  /** The recorded lifecycle state. */
  getState(): ContainerState {
    return this.controller.state();
  }

  /** Counts as activity, postponing idle sleep. */
  async renewActivityTimeout(): Promise<void> {
    await this.controller.touch();
  }

  /**
   * An HTTP request to a container port (default `defaultPort`), starting
   * the container if needed.
   */
  async containerFetch(
    input: Request | string | URL,
    init?: RequestInit,
    port?: number,
  ): Promise<Response> {
    return await this.controller.fetch(input, init, port);
  }

  /**
   * Forwards a request to `defaultPort`. An `x-celld-container-port` header
   * is removed, not obeyed; use {@link fetchPort} to reach another port.
   * Subclasses usually override this to route.
   */
  async fetch(request: Request): Promise<Response> {
    return await this.#forward(request, undefined);
  }

  /**
   * Forwards a request to `port`: the port is a trusted argument of the
   * caller (an RPC from the Worker), never read from the request. Answers
   * errors as `fetch` does.
   */
  async fetchPort(request: Request, port: number): Promise<Response> {
    return await this.#forward(request, port);
  }

  async #forward(
    request: Request,
    port: number | undefined,
  ): Promise<Response> {
    try {
      if (port !== undefined) checkPort(port);
      if (request.headers.has(PORT_HEADER)) {
        const headers = new Headers(request.headers);
        headers.delete(PORT_HEADER);
        request = new Request(request, { headers });
      }
      return await this.controller.fetch(request, undefined, port);
    } catch (error) {
      const known = ContainerError.from(error);
      if (known === null) throw error;
      // A 400 is about the port the Worker passed; a 503's detail is the
      // engine's and the container's, which a public caller must not see.
      const status = known.code === "invalid" ? 400 : 503;
      const message = status === 400 || this.unsafeDetail === true
        ? known.detail
        : "the container could not serve the request";
      return Response.json({ error: known.code, message }, { status });
    }
  }

  /** Idle sleep and crash checks; call `super.alarm()` from an override. */
  async alarm(): Promise<void> {
    await this.controller.alarm();
  }
}

/** The instance named `name` (default `"singleton"`). */
export function getContainer<T extends object>(
  namespace: DurableObjectNamespace<T>,
  name = "singleton",
): DurableObjectStub<T> {
  return namespace.getByName(name);
}

/**
 * One of `instances` (default 3, at most 1,024) interchangeable instances,
 * chosen uniformly at random (see `uniformIndex`).
 */
export function getRandom<T extends object>(
  namespace: DurableObjectNamespace<T>,
  instances = 3,
): DurableObjectStub<T> {
  let pick: number;
  try {
    pick = uniformIndex(instances);
  } catch (error) {
    throw new ContainerError("invalid", (error as Error).message);
  }
  return namespace.getByName(`instance-${pick}`);
}
