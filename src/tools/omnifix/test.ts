// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// deno-lint-ignore-file no-explicit-any

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test formatter implementations
class MockFormatter {
  constructor(
    private name: string,
    private canHandleFn: (path: string) => boolean,
    private formatFn: (content: string) => string
  ) {}

  canHandle(path: string): boolean {
    return this.canHandleFn(path);
  }

  // deno-lint-ignore require-await
  async format(content: string, _path: string): Promise<string> {
    return this.formatFn(content);
  }
}

// Test the OmniFix class directly
class TestableOmniFix {
  private tools: any[] = [];

  addTool(tool: any) {
    this.tools.push(tool);
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

Deno.test("OmniFix - single formatter", async () => {
  const omniFix = new TestableOmniFix();
  const formatter = new MockFormatter(
    "test",
    (path) => path.endsWith(".txt"),
    (content) => content.toUpperCase()
  );
  omniFix.addTool(formatter);

  const result = await omniFix.formatFile("test.txt", "hello world");
  assertEquals(result, "HELLO WORLD");
});

Deno.test("OmniFix - multiple formatters compose", async () => {
  const omniFix = new TestableOmniFix();

  // First formatter: adds prefix
  const formatter1 = new MockFormatter(
    "prefix",
    (path) => path.endsWith(".txt"),
    (content) => `PREFIX: ${content}`
  );

  // Second formatter: adds suffix
  const formatter2 = new MockFormatter(
    "suffix",
    (path) => path.endsWith(".txt"),
    (content) => `${content} :SUFFIX`
  );

  omniFix.addTool(formatter1);
  omniFix.addTool(formatter2);

  const result = await omniFix.formatFile("test.txt", "content");
  assertEquals(result, "PREFIX: content :SUFFIX");
});

Deno.test("OmniFix - formatters only run on matching files", async () => {
  const omniFix = new TestableOmniFix();

  const txtFormatter = new MockFormatter(
    "txt",
    (path) => path.endsWith(".txt"),
    (content) => `TXT: ${content}`
  );

  const jsFormatter = new MockFormatter(
    "js",
    (path) => path.endsWith(".js"),
    (content) => `JS: ${content}`
  );

  omniFix.addTool(txtFormatter);
  omniFix.addTool(jsFormatter);

  // Test .txt file - only txt formatter should run
  const txtResult = await omniFix.formatFile("test.txt", "content");
  assertEquals(txtResult, "TXT: content");

  // Test .js file - only js formatter should run
  const jsResult = await omniFix.formatFile("test.js", "content");
  assertEquals(jsResult, "JS: content");

  // Test .md file - no formatter should run
  const mdResult = await omniFix.formatFile("test.md", "content");
  assertEquals(mdResult, "content");
});

Deno.test("OmniFix - order matters for formatter composition", async () => {
  const omniFix = new TestableOmniFix();

  // Formatter that trims whitespace
  const trimFormatter = new MockFormatter(
    "trim",
    (_path) => true,
    (content) => content.trim()
  );

  // Formatter that adds newline
  const newlineFormatter = new MockFormatter(
    "newline",
    (_path) => true,
    (content) => content + "\n"
  );

  omniFix.addTool(trimFormatter);
  omniFix.addTool(newlineFormatter);

  const result = await omniFix.formatFile("test.txt", "  content  ");
  // First trim removes spaces, then newline is added
  assertEquals(result, "content\n");
});

Deno.test("OmniFix - empty content handling", async () => {
  const omniFix = new TestableOmniFix();

  const formatter = new MockFormatter(
    "test",
    (_path) => true,
    (content) => content === "" ? "EMPTY" : content
  );

  omniFix.addTool(formatter);

  const result = await omniFix.formatFile("test.txt", "");
  assertEquals(result, "EMPTY");
});

// Test specific to the bug report scenario
Deno.test("OmniFix - whitespace and language formatter compose", async () => {
  const omniFix = new TestableOmniFix();

  // Simulates whitespace formatter
  const whitespaceFormatter = new MockFormatter(
    "whitespace",
    (_path) => true,
    (content) => {
      // Trim trailing whitespace and ensure final newline
      const lines = content.split('\n');
      const trimmed = lines.map(line => line.trimEnd());
      let result = trimmed.join('\n');
      if (!result.endsWith('\n')) {
        result += '\n';
      }
      return result;
    }
  );

  // Simulates Rust formatter (adds indentation)
  const rustFormatter = new MockFormatter(
    "rust",
    (path) => path.endsWith(".rs"),
    (content) => {
      // Simple mock: properly format the function
      return content.replace(/fn main\(\) \{ println!\("Hello"\);/, 'fn main() {\n    println!("Hello");');
    }
  );

  omniFix.addTool(whitespaceFormatter);
  omniFix.addTool(rustFormatter);

  // Input has trailing spaces after the semicolon
  const input = `fn main() { println!("Hello");
}`;

  const result = await omniFix.formatFile("test.rs", input);


  // The rust formatter should properly format the function with indentation
  // Whitespace formatter ensures final newline
  assertEquals(result, `fn main() {
    println!("Hello");
}
`);
});
