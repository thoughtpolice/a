// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { readAll } from "https://deno.land/std@0.224.0/io/read_all.ts";

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

interface Config {
  tools: {
    rust?: RustConfig;
  };
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
      const args = ["--emit=stdout"];
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

// Main application class
class OmniFix {
  private tools: Tool[] = [];

  constructor(config: Config) {
    if (config.tools.rust !== undefined) {
      this.tools.push(new RustFormatter(config.tools.rust));
    } else {
      this.tools.push(new RustFormatter());
    }
  }

  async formatFile(path: string, content: string): Promise<string> {
    for (const tool of this.tools) {
      if (tool.canHandle(path)) {
        return await tool.format(content, path);
      }
    }

    return content; // do nothing if no tool is capable
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
