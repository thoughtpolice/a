// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `Container`: a Durable Object base class that owns one container, in the
 * shape of Cloudflare's `@cloudflare/containers`.
 *
 * ```ts
 * import { Container, getContainer } from "@celld/container/durable";
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
import { ContainerController, type WaitForPortOptions } from "./controller.ts";
import type { Duration } from "./duration.ts";
import { ContainerError } from "./errors.ts";
import type {
  ContainerState,
  RestartPolicy,
  StartOverrides,
  StopEvent,
} from "./types.ts";

/** The header {@link switchPort} sets and `Container.fetch` honours. */
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
  /** Idle time before the container is stopped (seconds, or `"10m"`). */
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

  #controller: ContainerController | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** The lifecycle controller, built from the class fields on first use. */
  protected get controller(): ContainerController {
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

  /** Kills the container at once. */
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
   * Forwards a request to `defaultPort`, or to the port a {@link switchPort}
   * header names. Subclasses usually override this to route.
   */
  async fetch(request: Request): Promise<Response> {
    const header = request.headers.get(PORT_HEADER);
    let port: number | undefined;
    if (header !== null) {
      port = Number(header);
      const headers = new Headers(request.headers);
      headers.delete(PORT_HEADER);
      request = new Request(request, { headers });
    }
    try {
      return await this.controller.fetch(request, undefined, port);
    } catch (error) {
      const known = ContainerError.from(error);
      if (known === null) throw error;
      const status = known.code === "invalid" ? 400 : 503;
      return Response.json({ error: known.code, message: known.detail }, {
        status,
      });
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

/** One of `instances` (default 3) interchangeable instances, chosen at random. */
export function getRandom<T extends object>(
  namespace: DurableObjectNamespace<T>,
  instances = 3,
): DurableObjectStub<T> {
  if (!Number.isInteger(instances) || instances < 1) {
    throw new ContainerError("invalid", "instances must be a positive integer");
  }
  const pick = crypto.getRandomValues(new Uint32Array(1))[0] % instances;
  return namespace.getByName(`instance-${pick}`);
}

/** `request` aimed at another container port by `Container.fetch`. */
export function switchPort(request: Request, port: number): Request {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ContainerError("invalid", `not a TCP port: ${port}`);
  }
  const headers = new Headers(request.headers);
  headers.set(PORT_HEADER, String(port));
  return new Request(request, { headers });
}
