// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The lobby's command set, as the CLI reference documents it.
 *
 * One entry per command path (`"share add"`, `"team settings vm-placement
 * pool"`), with its flags and one judgment of this library's: whether the
 * command is **idempotent**, meaning read-only, so that repeating it cannot
 * change anything. Only those are retried automatically. Everything that
 * creates, deletes, changes or charges is `idempotent: false` and is sent
 * once.
 *
 * The table serves four purposes: the client's retry decision, token `cmds`
 * validation, the in-memory fake's flag parser, and {@link catalogDrift},
 * which compares it against the live `help all`.
 *
 * `documented: false` marks commands that appear elsewhere in exe.dev's docs
 * but not in the CLI reference (`defaults`, `vm-logs`, `exe0-to-exe1`,
 * `integrations setup slack|discord`); exe.dev's FAQ warns that undocumented
 * commands may change.
 *
 * @module
 */

import { isPlainObject, type JsonValue } from "./json.ts";

/** One flag of a command. */
export interface FlagSpec {
  /** Whether the flag takes a value (`--name=x`); false for switches. */
  readonly value: boolean;
  /** Whether it may be given more than once. */
  readonly repeatable?: boolean;
  /** Whether it is a credential that the CLI can read from stdin with `-`. */
  readonly credential?: boolean;
}

/** One command path of the lobby. */
export interface CommandSpec {
  /** The command words, space separated: `"ssh-key generate-api-key"`. */
  readonly path: string;
  /** The CLI reference's one-line description. */
  readonly summary: string;
  /** The documented usage line. */
  readonly usage: string;
  /** Documented flags, keyed as written (`--name`, `-d`). */
  readonly flags: Readonly<Record<string, FlagSpec>>;
  /** Read-only, so safe to retry; see the module notes. */
  readonly idempotent: boolean;
  /** The docs page, relative to https://exe.dev/docs/. */
  readonly doc: string;
  /** Other spellings of the last word (`int` for `integrations`). */
  readonly aliases?: readonly string[];
  /** False when only mentioned outside the CLI reference. */
  readonly documented: boolean;
}

const V: FlagSpec = { value: true };
const R: FlagSpec = { value: true, repeatable: true };
const B: FlagSpec = { value: false };
const C: FlagSpec = { value: true, credential: true };

const CONTACT: Record<string, FlagSpec> = {
  "--email": V,
  "--name": V,
  "--business-name": V,
  "--phone": V,
  "--address-line1": V,
  "--address-line2": V,
  "--address-city": V,
  "--address-state": V,
  "--address-postal-code": V,
  "--address-country": V,
  "--tax-id-type": V,
  "--tax-id-value": V,
};

/**
 * Flags of `integrations add` and `integrations edit` across every documented
 * integration type. The CLI reference lists the generic ones; the type pages
 * (LLM, Slack, Discord, S3, WIF, catalog) add the rest.
 */
const INTEGRATION_TYPE_FLAGS: Record<string, FlagSpec> = {
  // LLM providers.
  "--openai": V,
  "--openai-key": C,
  "--openai-account": V,
  "--anthropic": V,
  "--anthropic-key": C,
  "--fireworks": V,
  "--fireworks-key": C,
  "--deepgram": V,
  "--deepgram-key": C,
  "--custom-provider": R,
  "--custom-provider-api": R,
  // Slack and Discord.
  "--webhook-url": C,
  "--bot-token": C,
  "--app-token": C,
  // Object storage (S3).
  "--endpoint": V,
  "--region": V,
  "--bucket": V,
  "--access-key-id": C,
  "--secret-access-key": C,
  // Identity federation.
  "--audience": V,
  "--consumer": V,
  "--metadata": R,
  "--role-arn": V,
  // Catalog services.
  "--base-url": V,
  "--subject": V,
  "--realm": V,
  "--key": C,
  "--token": C,
  "--username": V,
  "--password": C,
  "--client-id": V,
  "--client-secret": C,
  "--refresh-token": C,
  "--skip-verify": B,
};

const ENTRIES: readonly CommandSpec[] = [
  // Introspection.
  {
    path: "help",
    summary: "Show help information",
    usage: "help [command ...]",
    flags: {},
    idempotent: true,
    doc: "cli-help",
    documented: true,
  },
  {
    path: "doc",
    summary: "Browse documentation",
    usage: "doc [slug-or-query...]",
    flags: {},
    idempotent: true,
    doc: "cli-doc",
    documented: true,
  },
  // VM lifecycle.
  {
    path: "ls",
    summary: "List your VMs",
    usage: "ls [-l] [--group=tag|region|type] [name|pattern]",
    flags: { "-l": B, "--group": V },
    idempotent: true,
    doc: "cli-ls",
    documented: true,
  },
  {
    path: "new",
    summary: "Create a new VM",
    usage: "new [--name=<name>] [--image=<image>] [...]",
    flags: {
      "--comment": V,
      "--cpu": V,
      "--disk": V,
      "--env": R,
      "--image": V,
      "--integration": R,
      "--memory": V,
      "--name": V,
      "--no-email": B,
      "--no-pool": B,
      "--pool": V,
      "--prompt": V,
      "--registry-auth": V,
      "--sandbox": B,
      "--setup-script": V,
      "--standalone": B,
      "--tag": R,
    },
    idempotent: false,
    doc: "cli-new",
    documented: true,
  },
  {
    path: "rm",
    summary: "Delete a VM",
    usage: "rm <vmname>...",
    flags: {},
    idempotent: false,
    doc: "cli-rm",
    documented: true,
  },
  {
    path: "restart",
    summary: "Restart a VM",
    usage: "restart <vmname>",
    flags: {},
    idempotent: false,
    doc: "cli-restart",
    documented: true,
  },
  {
    path: "rename",
    summary: "rename a vm",
    usage: "rename <oldname> <newname>",
    flags: {},
    idempotent: false,
    doc: "cli-rename",
    documented: true,
  },
  {
    path: "tag",
    summary: "Add or remove tags on a VM",
    usage: "tag [-d] <vm> <tag-name> [tag-name...]",
    flags: { "-d": B },
    idempotent: false,
    doc: "cli-tag",
    documented: true,
  },
  {
    path: "cp",
    summary: "Copy an existing VM",
    usage:
      "cp <source-vm> [new-name] [--pool=<name>] [--memory=<size>] [--cpu=<count>] [--disk=<size>]",
    flags: {
      "--copy-tags": V,
      "--cpu": V,
      "--disk": V,
      "--memory": V,
      "--pool": V,
      "--sandbox": B,
      "--standalone": B,
    },
    idempotent: false,
    doc: "cli-cp",
    documented: true,
  },
  {
    path: "resize",
    summary: "Resize a VM's resources (memory, CPU, disk)",
    usage: "resize <vmname> [--memory=<size>] [--cpu=<count>] [--disk=<size>]",
    flags: { "--cpu": V, "--disk": V, "--memory": V },
    idempotent: false,
    doc: "cli-resize",
    documented: true,
  },
  {
    path: "comment",
    summary: "Set or clear a short comment on a VM",
    usage: "comment <hostname> <text>",
    flags: {},
    idempotent: false,
    doc: "cli-comment",
    documented: true,
  },
  {
    path: "stat",
    summary: "Show vCPU, disk, IO, and network (RX/TX) metrics for a VM",
    usage: "stat <vm-name> [--range=24h|7d|30d]",
    flags: { "--range": V },
    idempotent: true,
    doc: "cli-stat",
    documented: true,
  },
  {
    path: "vm-logs",
    summary: "Boot logs for debugging",
    usage: "vm-logs <vm>",
    flags: {},
    idempotent: true,
    doc: "agent-skill",
    documented: false,
  },
  {
    path: "ssh",
    summary: "SSH into a VM",
    usage: "ssh [-l user] [user@]vmname [command...]",
    flags: { "-l": V },
    idempotent: false,
    doc: "cli-ssh",
    documented: true,
  },
  {
    path: "grant-support-root",
    summary: "Allow exe.dev support to log in to a VM",
    usage: "grant-support-root <vmname> on|off",
    flags: {},
    idempotent: false,
    doc: "cli-grant-support-root",
    documented: true,
  },
  {
    path: "set-region",
    summary: "Set your preferred region for new VMs.",
    usage: "set-region <region-code>",
    flags: {},
    idempotent: false,
    doc: "cli-set-region",
    documented: true,
  },
  {
    path: "browser",
    summary: "Generate a magic link to log in to the website",
    usage: "browser",
    flags: { "--qr": B },
    idempotent: false,
    doc: "cli-browser",
    documented: true,
  },
  {
    path: "whoami",
    summary: "Show user information (email, keys, etc)",
    usage: "whoami",
    flags: {},
    idempotent: true,
    doc: "cli-whoami",
    documented: true,
  },
  {
    path: "exe0-to-exe1",
    summary: "Exchange an exe0 token for a short opaque exe1 token",
    usage: "exe0-to-exe1 [--vm=<vm>] <exe0-token>",
    flags: { "--vm": V },
    idempotent: false,
    doc: "https-api-local-key",
    documented: false,
  },
  // Custom domains.
  {
    path: "domain",
    summary: "Register custom domains for your VMs",
    usage: "domain <add|rm|ls> ...",
    flags: {},
    idempotent: true,
    doc: "cli-domain",
    documented: true,
  },
  {
    path: "domain add",
    summary: "Link a custom domain to a VM",
    usage: "domain add [--wildcard] <vm> <domain>",
    flags: { "--wildcard": B },
    idempotent: false,
    doc: "cli-domain",
    documented: true,
  },
  {
    path: "domain rm",
    summary: "Remove a custom domain from a VM",
    usage: "domain rm <vm> <domain>",
    flags: {},
    idempotent: false,
    doc: "cli-domain",
    documented: true,
  },
  {
    path: "domain ls",
    summary: "List custom domains for a VM (or -a for all your VMs)",
    usage: "domain ls <vm> | domain ls -a",
    flags: { "-a": B },
    idempotent: true,
    doc: "cli-domain",
    documented: true,
  },
  // Sharing.
  {
    path: "share",
    summary: "Share HTTPS VM access with others",
    usage: "share <subcommand> <vm> [args...]",
    flags: {},
    idempotent: true,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share show",
    summary: "Show current shares for a VM",
    usage: "share show <vm>",
    flags: { "--qr": B },
    idempotent: true,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share port",
    summary: "Set the HTTP proxy port for a VM",
    usage: "share port <vm> [port]",
    flags: {},
    idempotent: false,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share set-public",
    summary: "Make the HTTP proxy publicly accessible",
    usage: "share set-public <vm>",
    flags: {},
    idempotent: false,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share set-private",
    summary: "Restrict the HTTP proxy to authenticated users",
    usage: "share set-private <vm>",
    flags: {},
    idempotent: false,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share add",
    summary:
      "Share VM with a user via email, or grant shell access with --root",
    usage: "share add <vm> <email|team> [--root] [--message='...']",
    flags: { "--message": V, "--qr": B, "--root": B },
    idempotent: false,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share remove",
    summary:
      "Revoke a user's access to a VM, or downgrade shell access to web with --root",
    usage: "share remove <vm> <email|team> [--root]",
    flags: { "--root": B },
    idempotent: false,
    doc: "cli-share",
    documented: true,
  },
  {
    path: "share add-link",
    summary: "Create a shareable link for a VM",
    usage: "share add-link <vm>",
    flags: { "--qr": B },
    idempotent: false,
    doc: "cli-share",
    aliases: ["add-share-link"],
    documented: true,
  },
  {
    path: "share remove-link",
    summary: "Revoke a shareable link",
    usage: "share remove-link <vm> <token>",
    flags: {},
    idempotent: false,
    doc: "cli-share",
    aliases: ["remove-share-link"],
    documented: true,
  },
  {
    path: "share receive-email",
    summary: "Enable or disable inbound email for a VM",
    usage:
      "share receive-email <vm> [on|off] [--reply-policy=all|known|owner|none]",
    flags: { "--reply-policy": V },
    idempotent: false,
    doc: "cli-share",
    documented: true,
  },
  // SSH keys and tokens.
  {
    path: "ssh-key",
    summary: "Manage SSH keys for your account",
    usage: "ssh-key <subcommand> [args...]",
    flags: {},
    idempotent: true,
    doc: "cli-ssh-key",
    documented: true,
  },
  {
    path: "ssh-key list",
    summary: "List all SSH keys associated with your account",
    usage: "ssh-key list",
    flags: {},
    idempotent: true,
    doc: "cli-ssh-key",
    documented: true,
  },
  {
    path: "ssh-key add",
    summary: "Add a new SSH key to your account",
    usage: "ssh-key add [--tag=TAG] <public-key>",
    flags: { "--tag": V },
    idempotent: false,
    doc: "cli-ssh-key",
    documented: true,
  },
  {
    path: "ssh-key remove",
    summary: "Remove an SSH key from your account",
    usage: "ssh-key remove <name|fingerprint|public-key>",
    flags: {},
    idempotent: false,
    doc: "cli-ssh-key",
    documented: true,
  },
  {
    path: "ssh-key rename",
    summary: "Rename an SSH key",
    usage: "ssh-key rename <old-name> <new-name>",
    flags: {},
    idempotent: false,
    doc: "cli-ssh-key",
    documented: true,
  },
  {
    path: "ssh-key generate-api-key",
    summary:
      "Generate an API key for the exe.dev HTTPS API or for a specific VM",
    usage:
      "ssh-key generate-api-key [--label=NAME] [--vm=VMNAME] [--cmds=CMD1,CMD2] [--exp=30d]",
    flags: { "--cmds": V, "--exp": V, "--label": V, "--vm": V },
    idempotent: false,
    doc: "cli-ssh-key",
    documented: true,
  },
  // Integrations.
  {
    path: "integrations",
    summary: "Manage integrations",
    usage: "integrations <subcommand> [args...]",
    flags: {},
    idempotent: true,
    doc: "cli-integrations",
    aliases: ["int"],
    documented: true,
  },
  {
    path: "integrations list",
    summary: "List your integrations",
    usage: "integrations list [--json [--usage]]",
    flags: { "--usage": B },
    idempotent: true,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations setup",
    summary: "Set up a service integration",
    usage: "integrations setup <type> [args...]",
    flags: {},
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations setup github",
    summary: "Set up GitHub integration",
    usage: "integrations setup github [--list|--verify|-d]",
    flags: { "-d": B, "--delete": B, "--list": B, "--verify": B },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations setup chatgpt",
    summary: "Set up ChatGPT account access for LLM integrations",
    usage:
      "integrations setup chatgpt [--name=<account-name>|--list|--verify|-d]",
    flags: {
      "-d": B,
      "--delete": B,
      "--list": B,
      "--name": V,
      "--verify": B,
    },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations setup slack",
    summary: "Authorize the exe.dev Slack app and create a webhook integration",
    usage: "integrations setup slack",
    flags: {},
    idempotent: false,
    doc: "integrations-slack",
    documented: false,
  },
  {
    path: "integrations setup discord",
    summary:
      "Authorize the exe.dev Discord app and create a webhook integration",
    usage: "integrations setup discord",
    flags: {},
    idempotent: false,
    doc: "integrations-discord",
    documented: false,
  },
  {
    path: "integrations add",
    summary: "Add a new integration",
    usage: "integrations add <type> --name=<name> [--team] [args...]",
    flags: {
      "--act-as-user": B,
      "--attach": R,
      "--bearer": C,
      "--comment": V,
      "--fields": V,
      "--for": V,
      "--header": R,
      "--name": V,
      "--no-auth": B,
      "--peer": B,
      "--readonly": B,
      "--repository": V,
      "--strip-prefix": V,
      "--target": V,
      "--team": B,
      ...INTEGRATION_TYPE_FLAGS,
    },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations remove",
    summary: "Remove an integration",
    usage: "integrations remove <name> [--team]",
    flags: { "--team": B },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations test",
    summary: "Test an integration's credential (connection check)",
    usage: "integrations test <name> [--team]",
    flags: { "--team": B },
    idempotent: true,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations edit",
    summary: "Edit an integration",
    usage: "integrations edit <name> [--team] [args...]",
    flags: {
      "--act-as-user": B,
      "--bearer": C,
      "--clear-header": B,
      "--comment": V,
      "--fields": V,
      "--header": R,
      "--no-auth": B,
      "--readonly": B,
      "--repository": V,
      "--strip-prefix": V,
      "--target": V,
      "--team": B,
      ...INTEGRATION_TYPE_FLAGS,
    },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations attach",
    summary: "Attach an integration to a VM, tag, or all VMs",
    usage:
      "integrations attach <name> <spec> [--team] [--for <duration> | --until <time>]",
    flags: { "--for": V, "--team": B, "--until": V },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations detach",
    summary: "Detach an integration from a VM, tag, or all VMs",
    usage: "integrations detach <name> <spec> [--team]",
    flags: { "--team": B },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations rename",
    summary: "Rename an integration",
    usage: "integrations rename <name> <new-name> [--team]",
    flags: { "--team": B },
    idempotent: false,
    doc: "cli-integrations",
    documented: true,
  },
  {
    path: "integrations catalog",
    summary: "Browse the catalog of ready-made service integrations",
    usage: "integrations catalog [service-or-search-term]",
    flags: {},
    idempotent: true,
    doc: "cli-integrations",
    documented: true,
  },
  // Teams.
  {
    path: "team",
    summary: "View and manage your team",
    usage: "team",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team disable",
    summary: "Disband your team",
    usage: "team disable",
    flags: { "--yes": B },
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team members",
    summary: "List team members",
    usage: "team members",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    aliases: ["ls"],
    documented: true,
  },
  {
    path: "team usage",
    summary: "Show team pool, disk, and bandwidth usage for the billing period",
    usage: "team usage",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team add",
    summary: "Add a user to the team",
    usage: "team add <email> [<user|admin|billing_owner>]",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team remove",
    summary: "Remove a user from the team",
    usage: "team remove <email> [--transfer-vms-to <email>]",
    flags: { "--transfer-vms-to": V },
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team role",
    summary: "Change a team member's role",
    usage: "team role <email> <user|admin|billing_owner>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team rename",
    summary: "Rename your team",
    usage: "team rename <name>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team billing",
    summary: "Manage team billing information",
    usage: "team billing",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team billing plan",
    summary: "Show your team's plan",
    usage: "team billing plan [--all]",
    flags: { "--all": B },
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team billing update",
    summary: "Update team billing information",
    usage: "team billing update [--email=<email>] [...]",
    flags: CONTACT,
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team transfer",
    summary: "Transfer a VM to another team member",
    usage: "team transfer <vm_name> <target_email>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team auth",
    summary: "View and manage team auth settings",
    usage: "team auth",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team auth require-oidc",
    summary: "Require OIDC for web login (web|off)",
    usage: "team auth require-oidc <web|off>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team auth set",
    summary: "Set the team auth provider (default, google, oidc)",
    usage:
      "team auth set <default|google|oidc> [--issuer-url=<url> --client-id=<id> --client-secret=<secret>]",
    flags: {
      "--client-id": V,
      "--client-secret": V,
      "--display-name": V,
      "--issuer-url": V,
    },
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings",
    summary: "View and manage team settings",
    usage: "team settings",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings vm-placement",
    summary: "View and manage automatic VM placement",
    usage: "team settings vm-placement",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings vm-placement default",
    summary: "Use ordinary VM placement",
    usage: "team settings vm-placement default",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings vm-placement pool",
    summary: "Send bare new commands to a shared team pool",
    usage: "team settings vm-placement pool <name>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings vm-placement member-pool",
    summary: "Create or reuse one team pool per member for bare new commands",
    usage:
      "team settings vm-placement member-pool --cpus=N [--max-vms=N] [--host=alias]",
    flags: { "--cpus": V, "--host": V, "--max-vms": V },
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings vm-placement poolless",
    summary: "Keep bare new commands outside pools while migrating (legacy)",
    usage: "team settings vm-placement poolless",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings standalone",
    summary: "Set who can create standalone VMs",
    usage: "team settings standalone <off|admins-only|all-users>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings llm-gateway",
    summary: "Allow or block the exe.dev LLM gateway",
    usage: "team settings llm-gateway <on|off>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings vm-sharing",
    summary: "Set who can share team VMs",
    usage: "team settings vm-sharing <admins-only|all-members>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team settings auto-join",
    summary: "Allow users from your email domain to join this team on signup",
    usage: "team settings auto-join <on|off>",
    flags: {},
    idempotent: false,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team vm",
    summary: "View team members' VMs",
    usage: "team vm",
    flags: {},
    idempotent: true,
    doc: "cli-team",
    documented: true,
  },
  {
    path: "team vm ls",
    summary: "List all VMs across your team",
    usage:
      "team vm ls [-l] [--group=tag|region|type|user|access] [name|pattern]",
    flags: { "-l": B, "--group": V },
    idempotent: true,
    doc: "cli-team",
    aliases: ["list"],
    documented: true,
  },
  // Pools.
  {
    path: "pool",
    summary: "Manage your team's VM pools (reserved capacity slices)",
    usage: "pool <subcommand>",
    flags: {},
    idempotent: true,
    doc: "cli-pool",
    documented: true,
  },
  {
    path: "pool new",
    summary: "Create a pool: reserved capacity for your team's VMs",
    usage: "pool new <name> --cpus=N --region=<region> [--max-vms=M]",
    flags: { "--cpus": V, "--host": V, "--max-vms": V, "--region": V },
    idempotent: false,
    doc: "cli-pool",
    documented: true,
  },
  {
    path: "pool hosts",
    summary: "List the dedicated hosts assigned to your team",
    usage: "pool hosts",
    flags: {},
    idempotent: true,
    doc: "cli-pool",
    documented: true,
  },
  {
    path: "pool list",
    summary: "List your team's pools, or show historical usage with --usage",
    usage: "pool list [pool-name] [--usage [--range=24h|7d|30d]]",
    flags: { "--range": V, "--usage": B },
    idempotent: true,
    doc: "cli-pool",
    aliases: ["ls"],
    documented: true,
  },
  {
    path: "pool adopt",
    summary: "Adopt a VM into a pool; this can take several minutes",
    usage: "pool adopt --vm=<vm-name> --pool=<pool-name>",
    flags: { "--pool": V, "--vm": V },
    idempotent: false,
    doc: "cli-pool",
    documented: true,
  },
  {
    path: "pool detach",
    summary: "Detach a VM from its pool into its own standalone capacity",
    usage: "pool detach --vm=<vm-name>",
    flags: { "--vm": V },
    idempotent: false,
    doc: "cli-pool",
    documented: true,
  },
  {
    path: "pool resize",
    summary: "Change a pool's CPU capacity or VM cap",
    usage:
      "pool resize <name> --cpus=N | pool resize <name> --max-vms=N [--force]",
    flags: { "--cpus": V, "--force": B, "--max-vms": V },
    idempotent: false,
    doc: "cli-pool",
    documented: true,
  },
  {
    path: "pool delete",
    summary: "Delete a pool (refused while it has VMs; --force detaches them)",
    usage: "pool delete <name> [--force]",
    flags: { "--force": B },
    idempotent: false,
    doc: "cli-pool",
    documented: true,
  },
  // Billing.
  {
    path: "billing",
    summary: "View and manage your billing",
    usage: "billing",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing plan",
    summary: "Show your current plan and resource limits",
    usage: "billing plan [--all]",
    flags: { "--all": B },
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing usage",
    summary: "Show VM resource usage against your plan quotas",
    usage: "billing usage [--range=cycle|24h|7d|30d] [--group=vm]",
    flags: { "--group": V, "--range": V },
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing credits",
    summary: "Show Shelley credit balances",
    usage: "billing credits [usage|transactions|buy]",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing credits usage",
    summary: "Show Shelley (LLM) credit spend by model, day, or VM",
    usage:
      "billing credits usage [--month=YYYY-MM] [--group=model|day|box] [--detail]",
    flags: { "--detail": B, "--group": V, "--month": V },
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing credits transactions",
    summary: "Show your credit purchases and gifts",
    usage: "billing credits transactions [--limit=N]",
    flags: { "--limit": V },
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing credits buy",
    summary: "Buy Shelley credits with your personal payment method",
    usage: "billing credits buy <dollars> [--yes]",
    flags: { "--idempotency-key": V, "--yes": B },
    idempotent: false,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing rewards",
    summary: "Show invite rewards you've earned",
    usage: "billing rewards",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing capacity",
    summary: "Change your subscription capacity",
    usage: "billing capacity [--cpu=N] [--yes]",
    flags: { "--cpu": V, "--yes": B },
    idempotent: false,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing payment",
    summary: "Show your payment methods",
    usage: "billing payment [list]",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing payment list",
    summary: "List all payment methods on file",
    usage: "billing payment list",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing payment remove",
    summary: "Remove a saved payment method",
    usage: "billing payment remove <ref>",
    flags: {},
    idempotent: false,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing payment default",
    summary: "Make a saved payment method the default",
    usage: "billing payment default <ref>",
    flags: {},
    idempotent: false,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing manage",
    summary: "Open the billing management page",
    usage: "billing manage",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing update",
    summary: "Update your billing contact information",
    usage: "billing update [--email=<email>] [...]",
    flags: CONTACT,
    idempotent: false,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing invoices",
    summary: "Show recent invoices",
    usage: "billing invoices",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing receipts",
    summary: "Show credit purchase receipts and purchases",
    usage: "billing receipts [--from=<YYYY-MM-DD>] [--to=<YYYY-MM-DD>]",
    flags: { "--from": V, "--to": V },
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing statement",
    summary: "Open a consolidated credit purchase statement",
    usage: "billing statement [--from=<YYYY-MM-DD>] [--to=<YYYY-MM-DD>]",
    flags: { "--from": V, "--to": V },
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing provider",
    summary: "Connect a cloud marketplace subscription",
    usage: "billing provider link <aws|azure>",
    flags: {},
    idempotent: true,
    doc: "cli-billing",
    documented: true,
  },
  {
    path: "billing provider link",
    summary: "Connect a marketplace subscription to your team",
    usage:
      "billing provider link <aws|azure> --token=<link-token> [--size=small|medium|large|xlarge] [--team-name=<name>]",
    flags: { "--size": V, "--team-name": V, "--token": V },
    idempotent: false,
    doc: "cli-billing",
    documented: true,
  },
  // Invites.
  {
    path: "invite",
    summary: "Manage your invite link and rewards",
    usage: "invite",
    flags: {},
    idempotent: true,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite show",
    summary: "Show your active invite link and reward",
    usage: "invite show",
    flags: {},
    idempotent: true,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite link",
    summary: "Print only your active invite link",
    usage: "invite link",
    flags: {},
    idempotent: true,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite rewards",
    summary: "List invite rewards you can use",
    usage: "invite rewards",
    flags: {},
    idempotent: true,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite set-reward",
    summary: "Choose the reward for your invite link",
    usage: "invite set-reward standard|bonus-credits|extra-memory|extra-disk",
    flags: {},
    idempotent: false,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite activity",
    summary: "Show signups, upgrades, and reward status",
    usage: "invite activity",
    flags: {},
    idempotent: true,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite request",
    summary: "Request more trial invites",
    usage: "invite request",
    flags: {},
    idempotent: false,
    doc: "cli-invite",
    documented: true,
  },
  {
    path: "invite manage",
    summary: "Open the invites page",
    usage: "invite manage",
    flags: {},
    idempotent: true,
    doc: "cli-invite",
    documented: true,
  },
  // Shelley.
  {
    path: "shelley",
    summary: "Manage Shelley agent on VMs",
    usage: "shelley <subcommand> [args...]",
    flags: {},
    idempotent: true,
    doc: "cli-shelley",
    documented: true,
  },
  {
    path: "shelley install",
    summary: "Install or upgrade Shelley to the current version",
    usage: "shelley install <vm>",
    flags: {},
    idempotent: false,
    doc: "cli-shelley",
    documented: true,
  },
  {
    path: "shelley prompt",
    summary: "Send a prompt to Shelley on a VM",
    usage:
      "shelley prompt [--model=<model>] [--reasoning=<level>] <vm> <prompt>",
    flags: { "--model": V, "--reasoning": V },
    idempotent: false,
    doc: "cli-shelley",
    documented: true,
  },
  // Defaults (customization page).
  {
    path: "defaults",
    summary: "Read and write account defaults such as new.setup-script",
    usage: "defaults <read|write|delete> <domain> <key>",
    flags: {},
    idempotent: true,
    doc: "customization",
    documented: false,
  },
  {
    path: "defaults read",
    summary: "Read an account default",
    usage: "defaults read dev.exe new.setup-script",
    flags: {},
    idempotent: true,
    doc: "customization",
    documented: false,
  },
  {
    path: "defaults write",
    summary: "Write an account default",
    usage: "defaults write dev.exe new.setup-script <value>",
    flags: {},
    idempotent: false,
    doc: "customization",
    documented: false,
  },
  {
    path: "defaults delete",
    summary: "Delete an account default",
    usage: "defaults delete dev.exe new.setup-script",
    flags: {},
    idempotent: false,
    doc: "customization",
    documented: false,
  },
];

const GLOBAL_FLAGS: Readonly<Record<string, FlagSpec>> = {
  "--json": B,
  "--help": B,
};

/** Every command path, with `--json` and `--help` added to each one's flags. */
export const COMMANDS: readonly CommandSpec[] = Object.freeze(
  ENTRIES.map((entry) =>
    Object.freeze({
      ...entry,
      flags: Object.freeze({ ...entry.flags, ...GLOBAL_FLAGS }),
    })
  ),
);

const BY_PATH: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.map((entry) => [entry.path, entry]),
);

/** Looks up a command path such as `"share add"`. */
export function commandSpec(path: string): CommandSpec | undefined {
  return BY_PATH.get(path);
}

/** The documented top-level commands, including `exit` (REPL only). */
export const TOP_LEVEL_COMMANDS: readonly string[] = Object.freeze([
  ...new Set([...COMMANDS.map((entry) => entry.path.split(" ")[0]), "exit"]),
].sort());

/** A command line's words, split into its command path and the rest. */
export interface ResolvedCommand {
  readonly spec: CommandSpec;
  /** The canonical path, with aliases replaced (`int` becomes `integrations`). */
  readonly path: string;
  /** The words after the path: flags and positional arguments. */
  readonly rest: readonly string[];
}

/**
 * Finds the longest command path at the start of `words`, following the
 * documented aliases. Returns undefined for an unknown first word.
 */
export function resolveCommand(
  words: readonly string[],
): ResolvedCommand | undefined {
  let found: ResolvedCommand | undefined;
  let prefix: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidates = [word];
    for (const entry of COMMANDS) {
      const parts = entry.path.split(" ");
      if (
        parts.length === prefix.length + 1 &&
        parts.slice(0, -1).join(" ") === prefix.join(" ") &&
        entry.aliases?.includes(word)
      ) {
        candidates.push(parts[parts.length - 1]);
      }
    }
    const next = candidates
      .map((candidate) => [...prefix, candidate])
      .find((path) => BY_PATH.has(path.join(" ")));
    if (next === undefined) break;
    prefix = next;
    found = {
      spec: BY_PATH.get(prefix.join(" "))!,
      path: prefix.join(" "),
      rest: words.slice(i + 1),
    };
  }
  return found;
}

function collectCommandNames(value: JsonValue, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCommandNames(item, out);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const field of ["path", "command", "name"]) {
    const text = value[field];
    if (typeof text !== "string") continue;
    const words: string[] = [];
    for (const word of text.trim().split(/\s+/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
      words.push(word);
    }
    if (words.length > 0) out.add(words.join(" "));
    break;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/flag|option|example|alias|usage/i.test(key)) continue;
    if (typeof nested === "object" && nested !== null) {
      collectCommandNames(nested as JsonValue, out);
    }
  }
}

/** Whether every word of `path` resolves to a catalog command. */
function isKnownPath(path: string): boolean {
  if (path === "exit") return true;
  const resolved = resolveCommand(path.split(" "));
  return resolved !== undefined && resolved.rest.length === 0;
}

/** The result of {@link catalogDrift}. */
export interface CatalogDrift {
  /** Command paths the live server lists but this library does not know. */
  readonly unknown: readonly string[];
  /** Documented top-level commands the live listing does not mention. */
  readonly missing: readonly string[];
  /** Paths found in the live listing, in the order found. */
  readonly live: readonly string[];
}

/**
 * Compares the live command listing (the JSON of `help all`) with
 * {@link COMMANDS}.
 *
 * The docs do not show the JSON shape of `help all`, so this reads it
 * leniently: every object's `path`, `command` or `name` string contributes
 * its leading lowercase words as a command path, skipping members whose key
 * mentions flags, options, examples, aliases or usage. A path is known when
 * each of its words resolves in the catalog (aliases included). `missing`
 * compares top-level commands only, since `help all` may list one line per
 * top-level command.
 */
export function catalogDrift(help: JsonValue): CatalogDrift {
  const found = new Set<string>();
  collectCommandNames(help, found);
  const live = [...found];
  const unknown = live.filter((path) => !isKnownPath(path)).sort();
  const liveTop = new Set(
    live.map((path) => resolveCommand([path.split(" ")[0]])?.path ?? path),
  );
  const missing = TOP_LEVEL_COMMANDS.filter((name) =>
    name !== "exit" && !liveTop.has(name) &&
    commandSpec(name)?.documented === true
  );
  return { unknown, missing, live };
}
