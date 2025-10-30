// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { readAll } from "@std/io";

// Tool interface - all formatters must implement this
interface Tool {
  canHandle(path: string): boolean;
  format(content: string, path: string): Promise<string>;
}

// Configuration interfaces
interface RustConfig {
  enabled?: boolean;
  edition?: string;
  configPath?: string;
}

interface WhitespaceConfig {
  enabled?: boolean;
  trimTrailing?: boolean;
  ensureFinalNewline?: boolean;
}

interface Config {
  tools: {
    rust?: RustConfig;
    whitespace?: WhitespaceConfig;
  };
}

// File pattern matching helpers
const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".a",
  ".lock",
  ".hex0",
  ".hex1",
  ".hex2",
  ".M1",
  ".pyc",
  ".pyo",
  ".pyd",
  ".json",
  ".jsonl",
  ".jsonc",
  ".wasm",
  ".o",
  ".obj",
]);

const SKIP_PATTERNS = [
  /^\.jj\//,
  /^\.git\//,
  /^buck-out\//,
  /^\.direnv\//,
  /^cellar\//,
  /node_modules/,
  /^\.ruff_cache\//,
  /^buck\/third-party\/zuo\/lib/,
  /^buck\/third-party\/zuo\/local/,
  /^buck\/third-party\/zuo\/zuo.*/,
  /^work\//,
];

function shouldProcessFile(path: string): boolean {
  // Normalize path separators for cross-platform compatibility
  const normalizedPath = path.replace(/\\/g, "/");

  // Check if path matches any skip pattern
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return false;
    }
  }

  // Check file extension
  const lastDotIndex = path.lastIndexOf(".");
  if (lastDotIndex > 0) {
    const extension = path.substring(lastDotIndex).toLowerCase();
    if (SKIP_EXTENSIONS.has(extension)) {
      return false;
    }
  }

  // Skip dotslash files (files starting with . and no extension)
  const filename = path.split("/").pop() || "";
  if (filename.startsWith(".") && !filename.includes(".", 1)) {
    return false;
  }

  return true;
}

// Rust formatter implementation
class RustFormatter implements Tool {
  private config: RustConfig;

  constructor(config: RustConfig = {}) {
    this.config = {
      enabled: true,
      ...config,
    };
  }

  canHandle(path: string): boolean {
    return this.config.enabled !== false && path.endsWith(".rs");
  }

  async format(content: string, path: string): Promise<string> {
    try {
      const args = ["--emit=stdout", "--edition=2024"];
      if (this.config.edition) {
        args.push(`--edition=${this.config.edition}`);
      }
      if (this.config.configPath) {
        args.push(`--config-path=${this.config.configPath}`);
      }

      const command = new Deno.Command("rustfmt", {
        args,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });

      const process = command.spawn();

      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(content));
      await writer.close();
      const { code, stdout, stderr } = await process.output();

      if (code !== 0) {
        const errorMsg = new TextDecoder().decode(stderr);
        console.error(`rustfmt failed for ${path}: ${errorMsg}`);
        return content;
      }

      return new TextDecoder().decode(stdout);
    } catch (error) {
      console.error(`Error running rustfmt for ${path}: ${error}`);
      return content;
    }
  }
}

// Whitespace formatter implementation
class WhitespaceFormatter implements Tool {
  private config: WhitespaceConfig;

  constructor(config: WhitespaceConfig = {}) {
    this.config = {
      enabled: true,
      trimTrailing: true,
      ensureFinalNewline: true,
      ...config,
    };
  }

  canHandle(path: string): boolean {
    return this.config.enabled !== false && shouldProcessFile(path);
  }

  format(content: string, path: string): Promise<string> {
    try {
      // If the file is empty, return as-is
      if (content.length === 0) {
        return Promise.resolve(content);
      }

      let result = content;

      // Trim trailing whitespace if enabled
      if (this.config.trimTrailing !== false) {
        // Split by lines, preserving the line ending style
        const lines = result.split(/\r?\n/);
        const hasCarriageReturn = result.includes("\r\n");

        // Trim trailing whitespace from each line
        const trimmedLines = lines.map((line) => line.replace(/\s+$/, ""));

        // Rejoin with the original line ending style
        const lineEnding = hasCarriageReturn ? "\r\n" : "\n";
        result = trimmedLines.join(lineEnding);
      }

      // Ensure final newline if enabled
      if (this.config.ensureFinalNewline !== false) {
        // Check if the file ends with a newline
        if (!result.endsWith("\n")) {
          // Check if we should use CRLF or LF based on the file content
          const useCRLF = result.includes("\r\n");
          result += useCRLF ? "\r\n" : "\n";
        }
      }

      return Promise.resolve(result);
    } catch (error) {
      console.error(`Error processing whitespace for ${path}: ${error}`);
      return Promise.resolve(content); // Return original content on error
    }
  }
}

// Main application class
class OmniFix {
  private tools: Tool[] = [];

  constructor(config: Config) {
    // Add whitespace formatter first (it should run before language-specific formatters)
    if (config.tools.whitespace !== undefined) {
      this.tools.push(new WhitespaceFormatter(config.tools.whitespace));
    } else {
      this.tools.push(new WhitespaceFormatter());
    }

    // Add language-specific formatters
    if (config.tools.rust !== undefined) {
      this.tools.push(new RustFormatter(config.tools.rust));
    } else {
      this.tools.push(new RustFormatter());
    }
  }

  async formatFile(path: string, content: string): Promise<string> {
    let result = content;
    for (const tool of this.tools) {
      if (tool.canHandle(path)) {
        result = await tool.format(result, path);
      }
    }
    return result;
  }
}

function loadConfig(): Config {
  // TODO: In the future, read from JJ config environment variables
  // For now, use defaults
  return {
    tools: {
      rust: {
        enabled: true,
      },
      whitespace: {
        enabled: true,
        trimTrailing: true,
        ensureFinalNewline: true,
      },
    },
  };
}

if (import.meta.main) {
  try {
    if (Deno.args.length === 0) {
      console.error("Error: No file path provided");
      Deno.exit(1);
    }

    const filePath = Deno.args[0];

    const content = await readAll(Deno.stdin);
    const inputText = new TextDecoder().decode(content);
    const omniFix = new OmniFix(loadConfig());

    const formatted = await omniFix.formatFile(filePath, inputText);
    await Deno.stdout.write(new TextEncoder().encode(formatted));
  } catch (error) {
    console.error(`Fatal error: ${error}`);
    Deno.exit(1);
  }
}
