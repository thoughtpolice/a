// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared Buck2 validation utilities

// Validate Buck2 target for security and format correctness
export function validateBuckTarget(target: string): string | null {
  if (typeof target !== "string" || target.trim() === "") {
    return null;
  }

  const trimmed = target.trim();

  // Security: Block dangerous characters for command injection
  if (/[;&|`$(){}[\]<>'"\\]/.test(trimmed)) {
    return null;
  }

  // Security: Block absolute paths and directory traversal
  if (
    (trimmed.startsWith("/") && !trimmed.startsWith("//")) ||
    trimmed.includes("../") || trimmed.includes("./")
  ) {
    return null;
  }

  // Validate Buck2 target patterns:
  // :target, //path..., //path:target, cell//path...
  if (trimmed.startsWith(":")) {
    const name = trimmed.slice(1);
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  } else if (trimmed.startsWith("//")) {
    const path = trimmed.slice(2);
    if (!isValidBuckPath(path)) return null;
  } else if (trimmed.includes("//")) {
    const [cell, path] = trimmed.split("//", 2);
    if (
      !cell || !/^[a-zA-Z0-9_-]+$/.test(cell) || !path || !isValidBuckPath(path)
    ) {
      return null;
    }
  } else {
    return null;
  }

  return trimmed;
}

export function isValidBuckPath(path: string): boolean {
  // Handle recursive patterns like "src/..." or just "..."
  if (path.endsWith("...")) {
    path = path.slice(0, -3);
  }

  // Handle target specifications like "path:target"
  if (path.includes(":")) {
    const [pkgPath, target] = path.split(":", 2);
    if (target && !/^[a-zA-Z0-9._-]+$/.test(target)) return false;
    path = pkgPath;
  }

  // Empty path is valid (represents root or after removing "...")
  if (path === "") return true;

  // Validate each path segment
  return path.split("/").every((segment) => {
    // Allow empty segments (for cases like "//src/...")
    if (segment === "") return true;
    // Validate segment characters
    return /^[a-zA-Z0-9._-]+$/.test(segment);
  });
}

// Execute buck2 command with common patterns
export async function executeBuck2Command(
  args: string[],
  isolationDir = ".brainiac",
): Promise<{ code: number; stdout: string; stderr: string }> {
  let tempFile: string | null = null;

  try {
    // Create temporary file for at-file syntax
    tempFile = await Deno.makeTempFile({ suffix: ".txt" });

    // Write each argument on a separate line
    const argsContent = args.join("\n");
    await Deno.writeTextFile(tempFile, argsContent);

    const command = new Deno.Command("buck2", {
      args: ["--isolation-dir", isolationDir, `@${tempFile}`],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();

    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } finally {
    // Clean up temp file
    if (tempFile) {
      try {
        await Deno.remove(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
