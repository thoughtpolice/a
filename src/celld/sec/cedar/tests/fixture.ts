// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** A document-sharing model the suites share. */

import { type Entity, ref, uid } from "@celld/sec/cedar";

export const SCHEMA = `
entity User in [Team] { dept: String, level: Long };
entity Team;
entity Folder in [Folder];
entity Doc in [Folder] {
  owner: User,
  public: Bool,
  title: String,
  classification?: Long,
  tags: Set<String>,
};
action manage;
action read, comment, edit appliesTo {
  principal: User,
  resource: Doc,
  context: { mfa: Bool, ip?: ipaddr },
};
action delete in [manage] appliesTo {
  principal: User,
  resource: Doc,
  context: { mfa: Bool, ip?: ipaddr },
};
`;

export const POLICIES = `
@id("owners")
permit (principal, action, resource)
when { resource.owner == principal };

@id("public-read")
permit (principal, action == Action::"read", resource)
when { resource.public };

@id("team-folder")
permit (principal in Team::"eng", action in [Action::"read", Action::"comment"], resource in Folder::"eng");

@id("clearance")
permit (principal, action == Action::"read", resource)
when { resource has classification && principal.level >= resource.classification };

@id("admins")
permit (principal == User::"carol", action in Action::"manage", resource);

@id("no-delete-without-mfa")
forbid (principal, action == Action::"delete", resource)
unless { context.mfa };

@id("viewer")
permit (principal == ?principal, action == Action::"read", resource == ?resource);
`;

export const alice = uid("User", "alice");
export const bob = uid("User", "bob");
export const carol = uid("User", "carol");
export const eng = uid("Team", "eng");

export const USERS: Entity[] = [
  { uid: alice, attrs: { dept: "eng", level: 3 }, parents: [eng] },
  { uid: bob, attrs: { dept: "sales", level: 1 } },
  { uid: carol, attrs: { dept: "eng", level: 5 }, parents: [eng] },
  { uid: eng },
];

export const FOLDERS: Entity[] = [
  { uid: uid("Folder", "root") },
  { uid: uid("Folder", "eng"), parents: [uid("Folder", "root")] },
];

export function doc(id: string, attrs: {
  owner?: string;
  public?: boolean;
  title?: string;
  classification?: number;
  folder?: string;
  tags?: string[];
} = {}): Entity {
  return {
    uid: uid("Doc", id),
    attrs: {
      owner: ref("User", attrs.owner ?? "alice"),
      public: attrs.public ?? false,
      title: attrs.title ?? id,
      classification: attrs.classification,
      tags: attrs.tags ?? [],
    },
    parents: attrs.folder ? [uid("Folder", attrs.folder)] : [],
  };
}

/**
 * Conditions whose errors are easy to lose (a missing parent, an operand
 * whose value cannot matter, a type that does not fit), over attributes
 * `profile` (a record of `admin` and `level`), `name`, `level`, `tags`,
 * `owner` and `missing`.
 */
export const ERROR_CONDITIONS = [
  "resource.profile has admin",
  "resource has profile.admin",
  "resource.profile has admin && resource.profile.admin",
  "resource has profile && resource.profile has admin",
  "if resource has profile then resource.profile has admin else true",
  "!(resource.profile has admin)",
  "resource.profile.admin",
  "resource.profile.level >= 3",
  "[].contains(resource.missing)",
  "[].contains(resource.profile.admin)",
  "[1, 2].contains(resource.level)",
  "resource.missing in []",
  "resource.profile in []",
  "resource.owner in []",
  'resource.owner in [User::"alice"]',
  'resource.owner in User::"alice"',
  'resource.tags.contains("a")',
  'resource.name like "a*"',
  'resource.name == "abc"',
  "resource.level > 1",
];

/** Each condition as a permit and as a forbid, `when` and `unless`. */
export const WRAPPERS: ((condition: string) => string)[] = [
  (c) => `permit(principal, action, resource) when { ${c} };`,
  (c) => `permit(principal, action, resource) unless { ${c} };`,
  (c) =>
    `permit(principal, action, resource);\nforbid(principal, action, resource) when { ${c} };`,
  (c) =>
    `permit(principal, action, resource);\nforbid(principal, action, resource) unless { ${c} };`,
];
