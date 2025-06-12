// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { join } from "jsr:@std/path";
import { ensureDir } from "jsr:@std/fs";

/**
 * Runs a `jj` command safely in a way that won't snapshot by default.
 * @param args The arguments to pass to the `jj` command
 * @param snapshot Whether to snapshot the command (default: false)
 * @returns The output of the command
 */
async function runJJCommand(
  args: string[],
  snapshot: boolean = false,
): Promise<Deno.CommandOutput> {
  if (!snapshot) {
    args.unshift("--ignore-working-copy");
  }
  const command = new Deno.Command("jj", { args });
  return await command.output();
}

/**
 * Resolves revsets to concrete commit IDs
 * @param revsets Array of revsets to resolve
 * @param only_one Whether to ensure only one revision is returned
 * @returns Array of resolved commit IDs
 */
async function resolveRevset(
  revsets: string[],
  only_one: boolean = false,
): Promise<string[]> {
  // pass 'revsets' as multiple -r arguments to jj log
  const args = [
    "log",
    "--no-graph",
    "-T",
    'commit_id++"\\n"',
  ];
  for (const revset of revsets) {
    args.push("-r", revset);
  }
  const output = await runJJCommand(args);
  if (!output.success) {
    const errorMessage = new TextDecoder().decode(output.stderr);
    throw new Error(`Failed to resolve revsets: ${errorMessage}`);
  }
  const revs = new TextDecoder().decode(output.stdout)
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (only_one && revs.length > 1) {
    const errorMessage = `Expected only one revision, but found: ${
      revs.join(", ")
    }`;
    throw new Error(errorMessage);
  }

  return revs;
}

/**
 * Computes changes.txt content using jj diff between trunk and a target change
 * @param targetChange - The target change to compare against trunk
 * @returns The content of changes.txt
 */
async function computeVcsChanges(
  baseChange: string,
  targetChange: string,
): Promise<string> {
  const [[baseCommitId], [targetCommitId]] = await Promise.all([
    resolveRevset([baseChange], true),
    resolveRevset([targetChange], true),
  ]);

  console.error(
    `Computing changes from ${baseChange}=${baseCommitId} to ${targetChange}=${targetCommitId}...`,
  );

  const output = await runJJCommand([
    "diff",
    "--summary",
    "--from",
    baseCommitId,
    "--to",
    targetCommitId,
  ]);

  if (!output.success) {
    const errorMessage = new TextDecoder().decode(output.stderr);
    throw new Error(`Failed to compute changes: ${errorMessage}`);
  }

  return new TextDecoder().decode(output.stdout);
}

/**
 * Calculate the targets at a specific revision using supertd
 * @param revision - The revision to analyze
 * @param targetPatterns - Array of cell patterns to analyze (e.g. ["cell//..."])
 * @returns The content of the supertd output
 */
async function targetsAtRevision(
  revision: string,
  targetPatterns: string[],
): Promise<string> {
  const workspaceName = `quicktd_${crypto.randomUUID().substring(0, 8)}`;
  const workspacePath = `work/${workspaceName}`;

  try {
    console.error(
      `Setting up workspace ${workspaceName} for revision ${revision}...`,
    );

    const addWorkspaceOutput = await runJJCommand([
      "workspace",
      "add",
      "--sparse-patterns",
      "full",
      "--revision",
      revision,
      "--name",
      workspacePath,
      workspacePath,
    ]);
    if (!addWorkspaceOutput.success) {
      const errorMessage = new TextDecoder().decode(
        addWorkspaceOutput.stderr,
      );
      throw new Error(`Failed to add workspace: ${errorMessage}`);
    }

    // Run supertd targets command with the specified cell patterns
    console.error(`Running supertd targets for ${revision}...`);
    const supertdArgs = ["targets", "--isolation-dir", ".quicktd", ...targetPatterns];
    const supertdCmd = new Deno.Command("sh", {
      args: ["-c", `cd ${workspacePath} && supertd ${supertdArgs.join(" ")}`],
    });
    const supertdOutput = await supertdCmd.output();

    if (!supertdOutput.success) {
      const errorMessage = new TextDecoder().decode(supertdOutput.stderr);
      throw new Error(`Failed to run supertd: ${errorMessage}`);
    }

    // Return the content directly
    const outputContent = new TextDecoder().decode(supertdOutput.stdout);
    return outputContent;
  } finally {
    // Clean up
    const forgetOutput = await runJJCommand([
      "workspace",
      "forget",
      workspacePath,
    ]);
    if (!forgetOutput.success) {
      const errorMessage = new TextDecoder().decode(forgetOutput.stderr);
      console.error(`Failed to forget workspace: ${errorMessage}`);
    }
  }
}

/**
 * Computes base and diff jsonl files using supertd
 * @param baseRevision - The base revision (typically trunk)
 * @param targetRevision - The target revision to compare against
 * @param targetPatterns - Array of cell patterns to analyze (e.g. ["cell//..."])
 * @returns Object containing paths to base and diff jsonl files
 */
async function computeSupertdFiles(
  baseRevision: string,
  targetRevision: string,
  targetPatterns: string[],
): Promise<{
  baseJsonl: string;
  diffJsonl: string;
}> {
  console.error("Computing supertd files...");

  // Run supertd for both revisions in parallel
  const baseJsonl = await targetsAtRevision(baseRevision, targetPatterns);
  const diffJsonl = await targetsAtRevision(targetRevision, targetPatterns);

  return { baseJsonl, diffJsonl };
}

/**
 * Runs btd to determine targets based on changes
 * @param changesPath - Path to the changes.txt file
 * @param baseJsonl - Path to the base.jsonl file
 * @param diffJsonl - Path to the diff.jsonl file
 * @returns The output from btd
 */
async function runBtd(
  tempDir: string,
): Promise<string> {
  console.error("Running btd to determine targets...");

  const command = new Deno.Command("supertd", {
    args: [
      "btd",
      "--isolation-dir",
      ".quicktd",
      "--json-lines",
      "--base",
      join(tempDir, "base.jsonl"),
      "--diff",
      join(tempDir, "diff.jsonl"),
      "--changes",
      join(tempDir, "changes.txt"),
    ],
  });
  const output = await command.output();
  if (!output.success) {
    const errorMessage = new TextDecoder().decode(output.stderr);
    throw new Error(`Failed to run btd: ${errorMessage}`);
  }

  return new TextDecoder().decode(output.stdout);
}

/**
 * Main function to orchestrate the quicktd workflow
 * @param baseChange - The base change to compare against trunk
 * @param targetChange - The target change to compare against trunk
 * @param targetPatterns - Array of cell patterns to analyze (e.g. ["cell//..."])
 */
async function quickTd(
  baseChange: string,
  targetChange: string,
  targetPatterns: string[],
): Promise<void> {
  try {
    // Step 1: Compute changes.txt
    const changesContent = await computeVcsChanges(baseChange, targetChange);

    // Step 2: Compute base.jsonl and diff.jsonl using supertd
    const { baseJsonl, diffJsonl } = await computeSupertdFiles(
      "trunk()",
      targetChange,
      targetPatterns,
    );

    // Step 3: Create a random temporary directory under the system temporary
    // directory and write all 3 of the files into it
    const tempDir = join(
      Deno.env.get("TMPDIR") || "/tmp",
      `quicktd_${crypto.randomUUID().substring(0, 8)}`,
    );
    await ensureDir(tempDir);
    await Deno.writeTextFile(join(tempDir, "changes.txt"), changesContent);
    await Deno.writeTextFile(join(tempDir, "base.jsonl"), baseJsonl);
    await Deno.writeTextFile(join(tempDir, "diff.jsonl"), diffJsonl);

    // Step 3: Run btd to determine targets
    const btdOutput = await runBtd(tempDir);
    // Step 4: Write the JSON to the output directory, too
    await Deno.writeTextFile(join(tempDir, "targets.jsonl"), btdOutput);
    // Step 5: parse the line-delimited JSON and pull out the "target" key from
    // each entry transforming it into a new file, a simple line-delimited file
    // with a single target name on each line
    const finalTargetsFile = join(tempDir, "targets.txt");
    const trimmedOutput = btdOutput.trim();
    const targets = trimmedOutput === ""
      ? []
      : trimmedOutput
          .split("\n")
          .map((line) => {
            if (line.trim() === "") {
              return null;
            }
            try {
              const entry = JSON.parse(line);
              return entry.target;
            } catch (_e) {
              const errorMessage = `Failed to parse JSON line: ${line}`;
              throw new Error(errorMessage);
            }
          })
          .filter((target) => target !== null)
          .map((target) => target as string);

    await Deno.writeTextFile(
      finalTargetsFile,
      targets.join("\n"),
    );
    console.log(finalTargetsFile);
    console.error("QuickTD successful. Data at: ", tempDir);
  } catch (error: unknown) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
}

// Parse command line arguments
if (import.meta.main) {
  const args = Deno.args;
  if (args.length < 3) {
    console.error(
      "Usage: quicktd <baseChange> <targetChange> <targetPatterns...>",
    );
    Deno.exit(1);
  }
  quickTd(args[0], args[1], args.slice(2));
}
