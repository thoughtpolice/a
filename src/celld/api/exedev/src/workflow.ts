// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning a VM inside a Workflow: create, wait until running,
 * bootstrap, verify. Each helper is one or more `step.do` calls with stable
 * names, so a replay reuses stored results instead of acting again.
 *
 * A step can still run twice: its side effect may land and the run crash
 * before the result is stored, or the step's own retries may repeat it. So
 * each helper is safe to repeat by construction:
 *
 * - {@link provisionVm} lists before creating and adopts a VM that exists,
 *   and it needs an explicit name (`new` without one is not repeatable);
 *   after a failed `new` it lists again, since the VM may exist anyway.
 * - {@link bootstrapVm} guards its script with a marker file on the VM: the
 *   script runs until it succeeds once, then never again for that marker.
 *   Long scripts run detached (`setsid nohup`) with their status written to
 *   a file that later steps poll, which also sidesteps the 30 s request limit.
 * - {@link waitForVm} and {@link verifyVm} only read.
 *
 * Step results are plain data. Transient failures throw so the step's
 * durable retries take over (default 5 retries, exponential from 10 s);
 * permanent ones are returned as `{ok: false, error}`.
 *
 * @module
 */

import {
  type ExeClient,
  isAlreadyExists,
  type NewVmOptions,
  type RunOnVmOptions,
  type VmRunResult,
} from "./client.ts";
import type { CreatedVm, VmSummary } from "./decode.ts";
import {
  type ExeErrorData,
  ExeInvalidRequestError,
  outcome,
} from "./errors.ts";
import { base64Encode, quoteArg } from "./quote.ts";
import { type VmCommand, vmShellCommand } from "./vmexec.ts";

/** The step policy the helpers use unless given one. */
export const DEFAULT_STEP_CONFIG: WorkflowStepConfig = Object.freeze({
  retries: Object.freeze({
    limit: 5,
    delay: "10 seconds",
    backoff: "exponential",
  }) as WorkflowStepRetries,
  timeout: "2 minutes",
});

/** A step outcome: a value, or a permanent failure as plain data. */
export type StepOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExeErrorData };

/** Throws transient failures so the step retries; returns permanent ones. */
function settle<T>(result: StepOutcome<T>): StepOutcome<T> {
  if (!result.ok && (result.error.retryable || result.error.ambiguous)) {
    const error = new Error(result.error.message);
    error.name = `ExeError(${result.error.kind})`;
    throw error;
  }
  return result;
}

/** What {@link provisionVm} stores. */
export interface ProvisionedVm {
  readonly vm_name: string;
  /** False when the VM already existed and was adopted. */
  readonly created: boolean;
  readonly ssh_dest?: string;
  readonly https_url?: string;
}

function summary(vm: VmSummary | CreatedVm, created: boolean): ProvisionedVm {
  return {
    vm_name: vm.vm_name,
    created,
    ...(vm.ssh_dest === undefined ? {} : { ssh_dest: vm.ssh_dest }),
    ...(vm.https_url === undefined ? {} : { https_url: vm.https_url }),
  };
}

/**
 * Creates the VM `settings.name` unless it exists (one step, `name`).
 *
 * @throws {ExeInvalidRequestError} when `settings.name` is missing.
 */
export function provisionVm(
  step: WorkflowStep,
  name: string,
  client: ExeClient,
  settings: NewVmOptions & { readonly name: string },
  config: WorkflowStepConfig = DEFAULT_STEP_CONFIG,
): Promise<StepOutcome<ProvisionedVm>> {
  if (typeof settings.name !== "string" || settings.name === "") {
    throw new ExeInvalidRequestError([{
      path: ["name"],
      message:
        "provisionVm needs a VM name: it is what makes the step repeatable",
    }]);
  }
  return step.do(
    name,
    config,
    async (): Promise<StepOutcome<ProvisionedVm>> => {
      const listed = await outcome(client.getVm(settings.name));
      if (!listed.ok) return settle(listed);
      if (listed.value !== null) {
        return {
          ok: true,
          value: summary(listed.value, false),
        };
      }
      const created = await outcome(client.new(settings));
      if (created.ok) return { ok: true, value: summary(created.value, true) };
      if (
        created.error.ambiguous || isAlreadyExists(created.error) ||
        created.error.kind === "command_failed"
      ) {
        const again = await outcome(client.getVm(settings.name));
        if (again.ok && again.value !== null) {
          return {
            ok: true,
            value: summary(again.value, false),
          };
        }
      }
      return settle(created);
    },
  );
}

/** How {@link waitForVm} polls. */
export interface WaitOptions {
  /** Statuses that end the wait; default `["running"]`. */
  readonly statuses?: readonly string[];
  /** Polls before giving up; default 60. */
  readonly maxPolls?: number;
  /** The durable sleep between polls; default `"5 seconds"`. */
  readonly interval?: WorkflowDuration;
  readonly config?: WorkflowStepConfig;
}

/**
 * Polls `ls` until the VM reaches a wanted status. Each poll is a step
 * (`<name>:poll:<n>`) and each pause a durable sleep, so a replay resumes
 * where it was. Returns `{ok: false}` with kind `timeout` after `maxPolls`.
 */
export async function waitForVm(
  step: WorkflowStep,
  name: string,
  client: ExeClient,
  vm: string,
  options: WaitOptions = {},
): Promise<StepOutcome<VmSummary["status"]>> {
  const statuses = options.statuses ?? ["running"];
  const polls = options.maxPolls ?? 60;
  let last = "absent";
  for (let poll = 0; poll < polls; poll++) {
    const status = await step.do(
      `${name}:poll:${poll}`,
      options.config ?? DEFAULT_STEP_CONFIG,
      async (): Promise<StepOutcome<string>> => {
        const found = await outcome(client.getVm(vm));
        if (!found.ok) return settle(found);
        return { ok: true as const, value: found.value?.status ?? "absent" };
      },
    );
    if (!status.ok) return status;
    last = status.value;
    if (statuses.includes(status.value)) return status;
    if (poll + 1 < polls) {
      await step.sleep(
        `${name}:sleep:${poll}`,
        options.interval ?? "5 seconds",
      );
    }
  }
  return {
    ok: false,
    error: {
      kind: "timeout",
      message: `${vm} did not reach ${
        statuses.join("/")
      } after ${polls} polls (last: ${last})`,
      status: null,
      retryAfterMs: null,
      command: null,
      body: null,
      detail: null,
      issues: [],
      attempts: polls,
      retryable: false,
      ambiguous: false,
    },
  };
}

/** How {@link bootstrapVm} runs its script. */
export interface BootstrapOptions {
  /**
   * The marker's key: the script runs until it succeeds once per VM and key.
   * Default: a hash of the script, so changing the script runs it again.
   */
  readonly key?: string;
  /** The directory for markers, logs and status; default `$HOME/.exedev/bootstrap`. */
  readonly directory?: string;
  /** `inline` (one request, under 30 s) or `detached` (default) for longer scripts. */
  readonly mode?: "inline" | "detached";
  /** The interpreter; default `sh`. */
  readonly interpreter?: string;
  /** Status polls in detached mode; default 120. */
  readonly maxPolls?: number;
  /** The sleep between polls; default `"5 seconds"`. */
  readonly interval?: WorkflowDuration;
  readonly config?: WorkflowStepConfig;
  readonly run?: RunOnVmOptions;
}

/** What {@link bootstrapVm} stores. */
export interface BootstrapResult {
  readonly exitCode: number;
  /** True when an earlier run had already succeeded (marker present). */
  readonly skipped: boolean;
  /** The tail of the script's output (at most 16 KiB). */
  readonly output: string;
}

async function scriptKey(script: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)),
  );
  return Array.from(
    digest.subarray(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function tail(text: string, max = 16 * 1024): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

const SKIPPED = "__EXEDEV_BOOTSTRAP_ALREADY_DONE__";

/**
 * Runs `script` on the VM once: a marker file records success, so a repeated
 * step (or Workflow) skips it. A failing script is returned with its exit
 * code and output as `{ok: true, value: {exitCode != 0}}`, not thrown: the
 * caller decides whether to retry it.
 */
export async function bootstrapVm(
  step: WorkflowStep,
  name: string,
  client: ExeClient,
  vm: string,
  script: string,
  options: BootstrapOptions = {},
): Promise<StepOutcome<BootstrapResult>> {
  const key = options.key ?? await scriptKey(script);
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) {
    throw new ExeInvalidRequestError([{
      path: ["key"],
      message: "must be 1-64 of [A-Za-z0-9_.-]",
    }]);
  }
  const dir = options.directory ?? "$HOME/.exedev/bootstrap";
  const dirWord = options.directory === undefined
    ? `"$HOME/.exedev/bootstrap"`
    : quoteArg(dir);
  const done = `${dirWord}/${key}.done`;
  const status = `${dirWord}/${key}.status`;
  const log = `${dirWord}/${key}.log`;
  const interpreter = quoteArg(options.interpreter ?? "sh");
  const encoded = base64Encode(script);
  const body =
    `printf %s ${encoded} | base64 -d > ${dirWord}/${key}.script && ${interpreter} ${dirWord}/${key}.script`;
  const config = options.config ?? DEFAULT_STEP_CONFIG;
  const run = (command: VmCommand) =>
    outcome(client.runOnVm(vm, command, { ...options.run, idempotent: false }));

  if ((options.mode ?? "detached") === "inline") {
    return await step.do(
      name,
      config,
      async (): Promise<StepOutcome<BootstrapResult>> => {
        const shell =
          `mkdir -p ${dirWord} && if [ -f ${done} ]; then echo ${SKIPPED}; exit 0; fi; ( ${body} ); rc=$?; if [ "$rc" -eq 0 ]; then touch ${done}; fi; exit "$rc"`;
        const result = await run({ shell });
        if (!result.ok) return settle(result);
        return { ok: true as const, value: bootstrapResult(result.value) };
      },
    );
  }

  // Detached: start (unless done or already started), then poll the status file.
  const started = await step.do(
    `${name}:start`,
    config,
    async (): Promise<StepOutcome<boolean>> => {
      const shell =
        `mkdir -p ${dirWord} && if [ -f ${done} ]; then echo ${SKIPPED}; exit 0; fi; if [ -f ${status}.started ] && [ ! -f ${status} ]; then echo running; exit 0; fi; rm -f ${status}; touch ${status}.started; setsid nohup sh -c ${
          quoteArg(
            `( ${body} ) > ${log} 2>&1; rc=$?; if [ "$rc" -eq 0 ]; then touch ${done}; fi; echo "$rc" > ${status}.tmp && mv -f ${status}.tmp ${status}; rm -f ${status}.started`,
          )
        } > /dev/null 2>&1 < /dev/null & echo started`;
      const result = await run({ shell });
      if (!result.ok) return settle(result);
      if (result.value.exitCode !== 0) {
        return settle({
          ok: false as const,
          error: failedRun(result.value, "could not start the bootstrap"),
        });
      }
      return { ok: true as const, value: result.value.text.includes(SKIPPED) };
    },
  );
  if (!started.ok) return started;
  if (started.value) {
    return { ok: true, value: { exitCode: 0, skipped: true, output: "" } };
  }
  const polls = options.maxPolls ?? 120;
  for (let poll = 0; poll < polls; poll++) {
    const checked = await step.do(
      `${name}:status:${poll}`,
      config,
      async (): Promise<StepOutcome<BootstrapResult | null>> => {
        const result = await run({
          shell:
            `if [ -f ${status} ]; then cat ${status}; tail -c 16384 ${log} 2>/dev/null; else echo pending; fi`,
        });
        if (!result.ok) return settle(result);
        const [first, ...rest] = result.value.text.split("\n");
        if (first.trim() === "pending") {
          return { ok: true as const, value: null };
        }
        const code = Number(first.trim());
        if (!Number.isInteger(code)) {
          return settle({
            ok: false as const,
            error: failedRun(
              result.value,
              `unreadable status ${JSON.stringify(first)}`,
            ),
          });
        }
        return {
          ok: true as const,
          value: {
            exitCode: code,
            skipped: false,
            output: tail(rest.join("\n")),
          },
        };
      },
    );
    if (!checked.ok) {
      return checked;
    }
    if (checked.value !== null) return { ok: true, value: checked.value };
    if (poll + 1 < polls) {
      await step.sleep(
        `${name}:sleep:${poll}`,
        options.interval ?? "5 seconds",
      );
    }
  }
  return {
    ok: false,
    error: {
      kind: "timeout",
      message: `the bootstrap of ${vm} did not finish after ${polls} polls`,
      status: null,
      retryAfterMs: null,
      command: null,
      body: null,
      detail: null,
      issues: [],
      attempts: polls,
      retryable: false,
      ambiguous: false,
    },
  };
}

function bootstrapResult(run: VmRunResult): BootstrapResult {
  const skipped = run.text.includes(SKIPPED);
  return {
    exitCode: run.exitCode ?? -1,
    skipped,
    output: skipped ? "" : tail(run.text),
  };
}

function failedRun(run: VmRunResult, message: string): ExeErrorData {
  return {
    kind: "command_failed",
    message: `${message} on ${run.vm}: exit ${run.exitCode}: ${
      tail(run.text, 512)
    }`,
    status: null,
    retryAfterMs: null,
    command: null,
    body: tail(run.text, 4096),
    detail: null,
    issues: [],
    attempts: run.attempts,
    retryable: false,
    ambiguous: false,
  };
}

/** What {@link verifyVm} checks. */
export interface VerifyCheck {
  readonly command: VmCommand;
  /** The expected exit status; default 0. */
  readonly exitCode?: number;
  /** Text the output must contain. */
  readonly contains?: string;
}

/** What {@link verifyVm} stores. */
export interface VerifyResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly output: string;
}

/**
 * Runs a read-only check on the VM (one step). A failed check is a result
 * (`passed: false`), not an error; the command is retried on transient
 * failures, so it must not change anything.
 */
export function verifyVm(
  step: WorkflowStep,
  name: string,
  client: ExeClient,
  vm: string,
  check: VerifyCheck,
  config: WorkflowStepConfig = DEFAULT_STEP_CONFIG,
): Promise<StepOutcome<VerifyResult>> {
  vmShellCommand(check.command);
  return step.do(name, config, async () => {
    const result = await outcome(
      client.runOnVm(vm, check.command, { idempotent: true }),
    );
    if (!result.ok) return settle(result);
    const passed = result.value.exitCode === (check.exitCode ?? 0) &&
      (check.contains === undefined ||
        result.value.text.includes(check.contains));
    return {
      ok: true as const,
      value: {
        passed,
        exitCode: result.value.exitCode,
        output: tail(result.value.text),
      },
    };
  });
}
