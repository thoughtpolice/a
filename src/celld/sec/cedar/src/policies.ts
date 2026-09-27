// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Policy sets: static policies, templates and template links, each with a
 * stable id.
 *
 * Cedar names the policies of a text by position (`policy0`, ...), which
 * changes whenever a policy is added above another, and every decision's
 * `reasons` and every validation error name policies by id. So ids here
 * come from an annotation (`@id("owner-reads")` by default), falling back
 * to position only for policies without one.
 *
 * A {@link PolicySet} is immutable: `with`, `without`, `link` and `unlink`
 * return a new set, checked by Cedar, so a set that exists always parses.
 *
 * @module
 */

import {
  type Checked,
  type Diagnostic,
  orThrow,
  toDiagnostics,
} from "./diagnostics.ts";
import type * as ffi from "./ffi.ts";
import { type EntityUid, uid, uidFromJson, uidJson } from "./values.ts";
import { type CedarEngine, sharedEngine } from "./wasm.ts";

/** One static policy or template. */
export interface Policy {
  readonly id: string;
  readonly kind: "policy" | "template";
  /** This policy's Cedar text, annotations included. */
  readonly text: string;
  /** The same policy in Cedar's JSON format. */
  readonly json: ffi.PolicyJson;
  readonly effect: ffi.Effect;
  readonly annotations: ffi.Annotations;
}

/**
 * A template link: the template with `?principal` and `?resource` filled
 * in, which Cedar evaluates as a policy named `id`. Sharing ("give Alice
 * `editor` on this document") is usually a link.
 */
export interface Link {
  readonly id: string;
  readonly template: string;
  readonly principal?: EntityUid;
  readonly resource?: EntityUid;
}

/** Options for parsing and building policy sets. */
export interface PolicyOptions {
  /** The annotation holding a policy's id (default `id`); `false` uses positions. */
  readonly idAnnotation?: string | false;
  readonly engine?: CedarEngine;
}

/** An immutable, parsed policy set. */
export class PolicySet {
  readonly #policies: ReadonlyMap<string, Policy>;
  readonly #links: ReadonlyMap<string, Link>;
  readonly #engine: CedarEngine;
  #ffi: ffi.PolicySet | null = null;

  private constructor(
    policies: ReadonlyMap<string, Policy>,
    links: ReadonlyMap<string, Link>,
    engine: CedarEngine,
  ) {
    this.#policies = policies;
    this.#links = links;
    this.#engine = engine;
  }

  /** The empty set. */
  static empty(options: PolicyOptions = {}): PolicySet {
    return new PolicySet(
      new Map(),
      new Map(),
      options.engine ?? sharedEngine(),
    );
  }

  /**
   * Parses Cedar text of any number of policies and templates. Errors
   * point into `text`.
   */
  static parse(text: string, options: PolicyOptions = {}): Checked<PolicySet> {
    const engine = options.engine ?? sharedEngine();
    const parts = engine.policySetTextToParts(text);
    if (parts.type === "failure") {
      return {
        ok: false,
        errors: toDiagnostics(parts.errors, { source: () => text }),
      };
    }
    const policies = new Map<string, Policy>();
    const errors: Diagnostic[] = [];
    const annotation = options.idAnnotation ?? "id";
    const add = (partText: string, kind: Policy["kind"], position: number) => {
      const parsed = describe(engine, partText, kind);
      if (!parsed.ok) {
        errors.push(...parsed.errors);
        return;
      }
      const named = annotation === false
        ? undefined
        : parsed.value.annotations[annotation];
      const id = named ?? `${kind}${position}`;
      if (policies.has(id)) {
        errors.push(
          problem(
            `two policies have the id ${JSON.stringify(id)}`,
            id,
            "give each policy its own @id annotation",
          ),
        );
        return;
      }
      policies.set(id, { id, kind, text: partText, ...parsed.value });
    };
    parts.policies.forEach((part, i) => add(part, "policy", i));
    parts.policy_templates.forEach((part, i) => add(part, "template", i));
    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      value: new PolicySet(policies, new Map(), engine),
      warnings: [],
    };
  }

  /** {@link parse}, throwing a `CedarError` with the diagnostics. */
  static parseOrThrow(text: string, options: PolicyOptions = {}): PolicySet {
    return orThrow(
      PolicySet.parse(text, options),
      "the policies do not parse",
      () => text,
    );
  }

  /**
   * Builds a set from stored parts: each text one policy or template, with
   * its id given (any `@id` annotation in the text is kept but not used).
   */
  static fromParts(
    parts: {
      readonly policies?: Readonly<Record<string, string>>;
      readonly templates?: Readonly<Record<string, string>>;
      readonly links?: readonly Link[];
    },
    options: PolicyOptions = {},
  ): Checked<PolicySet> {
    const engine = options.engine ?? sharedEngine();
    const policies = new Map<string, Policy>();
    const errors: Diagnostic[] = [];
    for (
      const [kind, entries] of [["policy", parts.policies ?? {}], [
        "template",
        parts.templates ?? {},
      ]] as const
    ) {
      for (const [id, text] of Object.entries(entries)) {
        if (policies.has(id)) {
          errors.push(
            problem(
              `a policy and a template both have the id ${JSON.stringify(id)}`,
              id,
            ),
          );
          continue;
        }
        const parsed = describe(engine, text, kind, id);
        if (parsed.ok) policies.set(id, { id, kind, text, ...parsed.value });
        else errors.push(...parsed.errors);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    const set = new PolicySet(policies, new Map(), engine);
    return set.#withLinks(parts.links ?? []);
  }

  /** Every static policy and template, by id. */
  get(id: string): Policy | undefined {
    return this.#policies.get(id);
  }

  /** Whether `id` names a policy, template or link. */
  has(id: string): boolean {
    return this.#policies.has(id) || this.#links.has(id);
  }

  policies(): Policy[] {
    return [...this.#policies.values()].filter((policy) =>
      policy.kind === "policy"
    );
  }

  templates(): Policy[] {
    return [...this.#policies.values()].filter((policy) =>
      policy.kind === "template"
    );
  }

  links(): Link[] {
    return [...this.#links.values()];
  }

  getLink(id: string): Link | undefined {
    return this.#links.get(id);
  }

  get size(): number {
    return this.#policies.size + this.#links.size;
  }

  /** The text of the policy or template `id`, for rendering diagnostics. */
  sourceOf(id: string | undefined): string | undefined {
    return id === undefined ? undefined : this.#policies.get(id)?.text;
  }

  /**
   * Adds or replaces the policy or template `id` from one policy's text.
   * Whether it is a template follows from its slots.
   */
  with(id: string, text: string): Checked<PolicySet> {
    const kind = hasSlots(text) ? "template" : "policy";
    const parsed = describe(this.#engine, text, kind, id);
    if (!parsed.ok) return parsed;
    if (this.#links.has(id)) {
      return {
        ok: false,
        errors: [problem(`${JSON.stringify(id)} is already a link's id`, id)],
      };
    }
    const previous = this.#policies.get(id);
    if (
      previous?.kind === "template" && kind === "policy" &&
      this.#linksOf(id).length > 0
    ) {
      return {
        ok: false,
        errors: [
          problem(
            `template ${
              JSON.stringify(id)
            } has links; unlink them before making it a static policy`,
            id,
          ),
        ],
      };
    }
    const policies = new Map(this.#policies);
    policies.set(id, { id, kind, text, ...parsed.value });
    return new PolicySet(policies, new Map(), this.#engine).#withLinks([
      ...this.#links.values(),
    ]);
  }

  /** Removes a policy, template (which must have no links) or link. */
  without(id: string): Checked<PolicySet> {
    if (this.#links.has(id)) return this.unlink(id);
    if (!this.#policies.has(id)) {
      return {
        ok: false,
        errors: [problem(`no policy has the id ${JSON.stringify(id)}`, id)],
      };
    }
    const links = this.#linksOf(id);
    if (links.length > 0) {
      return {
        ok: false,
        errors: [
          problem(
            `template ${JSON.stringify(id)} still has ${links.length} link(s)`,
            id,
            "unlink them first",
          ),
        ],
      };
    }
    const policies = new Map(this.#policies);
    policies.delete(id);
    return {
      ok: true,
      value: new PolicySet(policies, this.#links, this.#engine),
      warnings: [],
    };
  }

  /** Links a template; Cedar checks that the slots match. */
  link(link: Link): Checked<PolicySet> {
    if (this.has(link.id)) {
      return {
        ok: false,
        errors: [
          problem(`the id ${JSON.stringify(link.id)} is taken`, link.id),
        ],
      };
    }
    return this.#withLinks([...this.#links.values(), link]);
  }

  unlink(id: string): Checked<PolicySet> {
    if (!this.#links.has(id)) {
      return {
        ok: false,
        errors: [problem(`no link has the id ${JSON.stringify(id)}`, id)],
      };
    }
    const links = new Map(this.#links);
    links.delete(id);
    return {
      ok: true,
      value: new PolicySet(this.#policies, links, this.#engine),
      warnings: [],
    };
  }

  /** The links of template `id`. */
  #linksOf(id: string): Link[] {
    return [...this.#links.values()].filter((link) => link.template === id);
  }

  #withLinks(links: readonly Link[]): Checked<PolicySet> {
    const byId = new Map<string, Link>();
    const errors: Diagnostic[] = [];
    for (const link of links) {
      const template = this.#policies.get(link.template);
      if (template?.kind !== "template") {
        errors.push(
          problem(
            `link ${JSON.stringify(link.id)} names ${
              JSON.stringify(link.template)
            }, which is not a template`,
            link.id,
          ),
        );
        continue;
      }
      if (byId.has(link.id) || this.#policies.has(link.id)) {
        errors.push(
          problem(`the id ${JSON.stringify(link.id)} is taken`, link.id),
        );
        continue;
      }
      byId.set(link.id, freezeLink(link));
    }
    if (errors.length > 0) return { ok: false, errors };
    const set = new PolicySet(this.#policies, byId, this.#engine);
    if (byId.size === 0) return { ok: true, value: set, warnings: [] };
    const checked = this.#engine.checkParsePolicySet(set.toFfi());
    if (checked.type === "failure") {
      return { ok: false, errors: toDiagnostics(checked.errors) };
    }
    return { ok: true, value: set, warnings: [] };
  }

  /** The set in the FFI's form, keyed by id. */
  toFfi(): ffi.PolicySet {
    if (this.#ffi !== null) return this.#ffi;
    const staticPolicies: Record<string, string> = {};
    const templates: Record<string, string> = {};
    for (const policy of this.#policies.values()) {
      (policy.kind === "policy" ? staticPolicies : templates)[policy.id] =
        policy.text;
    }
    const templateLinks = [...this.#links.values()].map((
      link,
    ): ffi.TemplateLink => ({
      templateId: link.template,
      newId: link.id,
      values: {
        ...(link.principal ? { "?principal": uidJson(link.principal) } : {}),
        ...(link.resource ? { "?resource": uidJson(link.resource) } : {}),
      },
    }));
    return this.#ffi = { staticPolicies, templates, templateLinks };
  }

  /**
   * The static policies and templates as one Cedar text, each carrying an
   * `@id` annotation with its id (added where the text has none), so that
   * parsing the text gives the same ids. Links are not text; keep them
   * with {@link links}.
   */
  toText(options: { readonly idAnnotation?: string } = {}): string {
    const annotation = options.idAnnotation ?? "id";
    return [...this.#policies.values()].map((policy) => {
      if (policy.annotations[annotation] === policy.id) return policy.text;
      if (annotation in policy.annotations) {
        throw new RangeError(
          `policy ${JSON.stringify(policy.id)} has @${annotation}(${
            JSON.stringify(policy.annotations[annotation])
          }), which is not its id`,
        );
      }
      return `@${annotation}(${JSON.stringify(policy.id)})\n${policy.text}`;
    }).join("\n\n");
  }
}

/** Parses one policy or template text into its JSON, effect and annotations. */
function describe(
  engine: CedarEngine,
  text: string,
  kind: Policy["kind"],
  id?: string,
): Checked<Omit<Policy, "id" | "kind" | "text">> {
  const parts = engine.policySetTextToParts(text);
  if (parts.type === "failure") {
    return {
      ok: false,
      errors: toDiagnostics(parts.errors, {
        policyId: () => id,
        source: () => text,
      }),
    };
  }
  const count = parts.policies.length + parts.policy_templates.length;
  if (count !== 1) {
    return {
      ok: false,
      errors: [
        problem(
          `expected one ${kind}, found ${count} policies and templates`,
          id,
        ),
      ],
    };
  }
  const answer = kind === "policy"
    ? engine.policyToJson(text)
    : engine.templateToJson(text);
  if (answer.type === "failure") {
    return {
      ok: false,
      errors: toDiagnostics(answer.errors, {
        policyId: () => id,
        source: () => text,
      }),
    };
  }
  const json = answer.json;
  return {
    ok: true,
    value: { json, effect: json.effect, annotations: json.annotations ?? {} },
    warnings: [],
  };
}

function hasSlots(text: string): boolean {
  // A cheap guess that `describe` confirms: a static policy with a slot and
  // a template without one both fail to parse as the kind guessed.
  return /\?(principal|resource)\b/.test(text);
}

function freezeLink(link: Link): Link {
  return Object.freeze({
    id: link.id,
    template: link.template,
    ...(link.principal
      ? { principal: uid(link.principal.type, link.principal.id) }
      : {}),
    ...(link.resource
      ? { resource: uid(link.resource.type, link.resource.id) }
      : {}),
  });
}

/** A diagnostic of our own, in Cedar's shape. */
export function problem(
  message: string,
  policyId?: string,
  help?: string,
): Diagnostic {
  return {
    severity: "error",
    message,
    ...(help ? { help } : {}),
    ...(policyId !== undefined ? { policyId } : {}),
    spans: [],
    related: [],
  };
}

/** The link's slot values as the FFI reads them back. */
export function linkFromFfi(link: ffi.TemplateLink): Link {
  const principal = link.values["?principal"];
  const resource = link.values["?resource"];
  return {
    id: link.newId,
    template: link.templateId,
    ...(principal ? { principal: uidFromJson(principal) } : {}),
    ...(resource ? { resource: uidFromJson(resource) } : {}),
  };
}

/** Options for {@link formatPolicies}. */
export interface FormatOptions {
  readonly lineWidth?: number;
  readonly indentWidth?: number;
  readonly engine?: CedarEngine;
}

/** Formats Cedar policy text the way `cedar format` does. */
export function formatPolicies(
  text: string,
  options: FormatOptions = {},
): Checked<string> {
  const engine = options.engine ?? sharedEngine();
  const answer = engine.formatPolicies({
    policyText: text,
    ...(options.lineWidth !== undefined
      ? { lineWidth: options.lineWidth }
      : {}),
    ...(options.indentWidth !== undefined
      ? { indentWidth: options.indentWidth }
      : {}),
  });
  if (answer.type === "failure") {
    return {
      ok: false,
      errors: toDiagnostics(answer.errors, { source: () => text }),
    };
  }
  return { ok: true, value: answer.formatted_policy, warnings: [] };
}
