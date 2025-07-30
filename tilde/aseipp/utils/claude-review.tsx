// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This is a simple program that can do code review of a given diff. The
// intention is that you would use this in order to review your patch series
// before sending it off to actually be code reviewed.
//
// The original idea (and prompt!) for this tool
// came from "An AI tool I find useful", by Bill Mill
// <https://notes.billmill.org/blog/2025/07/An_AI_tool_I_find_useful.html>

// cli, logging, etc
import { Command, EnumType } from "@cliffy/command";

// core UI stuff
import React from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";

import * as marked from "marked";
import TerminalRenderer from "marked-terminal";
import type TerminalRendererOptions from "marked-terminal";

// claude
import { query } from "@anthropic-ai/claude-code";

// ---------------------------------------------------------------------------------------------------------------------

const CLAUDE_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
] as const;
type ClaudeModel = typeof CLAUDE_MODELS[number];

/** The default model to use for review. */
const defaultClaudeModel: ClaudeModel = "claude-sonnet-4-20250514";

/** The prompt that is appended to the system prompt. */
const additionalSystemPrompt =
  `Review the following diff as if you were a senior engineer.

## Focus Areas
- Architecture and design decisions
- Potential bugs and edge cases
- Performance considerations
- Security implications
- Code maintainability and best practices
- Test coverage

## Review Format
- Start with a brief summary of the PR purpose and changes
- List strengths of the implementation
- Identify issues and improvement opportunities (ordered by priority)
- Provide specific code examples for suggested changes where applicable

Use your agents and other tools to do this. Use sub-agents to do research across the codebase if you need further context on the diff.
Please be specific, constructive, and actionable in your feedback. YOU MUST OUTPUT YOUR REVIEW IN WELL STRUCTURED MARKDOWN FORMAT!`;

// ---------------------------------------------------------------------------------------------------------------------

/** Status component. This is used to indicate what the current  */
const StatusLine: React.FC<{ isActive: boolean; statusText: string }> = (
  { isActive, statusText },
) => {
  if (!isActive) return null;

  return (
    <Box marginTop={1} borderStyle="round" borderColor="green">
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text>{" " + statusText}</Text>
    </Box>
  );
};

type MarkdownProps = TerminalRendererOptions & {
  children: string;
};

function Markdown({
  children,
  ...options
}: MarkdownProps): React.ReactElement {
  const rendered = React.useMemo(() => {
    marked.setOptions({
      renderer: new TerminalRenderer({ ...options }),
    });
    const parsed = marked.parse(children, { async: false }).trim();
    return parsed;
  }, [
    children,
  ]);

  return <Text>{rendered}</Text>;
}

interface ReviewContentProps {
  content: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  cost?: {
    total_cost: number;
  };
}

const ReviewContent: React.FC<ReviewContentProps> = (
  { content, usage, cost },
) => {
  const { exit } = useApp();

  // Handle exit on Ctrl+C
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box flexDirection="column">
        {content
          ? <Markdown>{content}</Markdown>
          : <Text dimColor>Waiting for response from Claude...</Text>}
      </Box>
      {usage && (
        <Box marginTop={1}>
          <Text dimColor>
            Tokens: {usage.input_tokens} in, {usage.output_tokens} out
            {cost && ` (Cost: $${cost.total_cost.toFixed(4)})`}
          </Text>
        </Box>
      )}
    </Box>
  );
};

interface DebugLogEntry {
  timestamp: number;
  type: "tool_use" | "system" | "user" | "thinking" | "assistant";
  content: string;
}

interface DebugLogProps {
  entries: DebugLogEntry[];
  maxEntries?: number;
}

const DebugLog: React.FC<DebugLogProps> = ({ entries, maxEntries = 20 }) => {
  const displayEntries = entries.slice(-maxEntries);

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
      <Text bold color="yellow">Debug Log:</Text>
      {displayEntries.map((entry, index) => {
        const time = new Date(entry.timestamp).toLocaleTimeString();
        let icon = "";
        let color: string = "white";

        switch (entry.type) {
          case "tool_use":
            icon = "🔧";
            color = "cyan";
            break;
          case "system":
            icon = "📋";
            color = "gray";
            break;
          case "user":
            icon = "✅";
            color = "green";
            break;
          case "thinking":
            icon = "💭";
            color = "magenta";
            break;
          case "assistant":
            icon = "🤖";
            color = "blue";
            break;
        }

        return (
          <Text key={index} color={color}>
            [{time}] {icon} {entry.content}
          </Text>
        );
      })}
    </Box>
  );
};

// ---------------------------------------------------------------------------------------------------------------------

const logLevelType = new EnumType(["debug", "info", "warn", "error"]);
const claudeModelType = new EnumType(CLAUDE_MODELS);

await new Command()
  .name("claude-review")
  .version("0.1.0")
  .description("Simple code review tool based on Claude Code")
  .type("log-level", logLevelType)
  .type("model-type", claudeModelType)
  .env("DEBUG=<enable:boolean>", "Enable debug output.")
  .option("-d, --debug", "Enable debug output.")
  .option("-l, --log-level <level:log-level>", "Set log level.", {
    default: "info",
  })
  .option("-m, --model <model:model-type>", "Specify model to use", {
    default: defaultClaudeModel,
  })
  .arguments("<input:string>")
  .action(async (options, ...args) => {
    const jjdiff = new Deno.Command("jj", {
      args: ["diff", "--git", "-r", args[0]],
      stdout: "piped",
    });
    const diff = new TextDecoder().decode(jjdiff.outputSync().stdout);

    // Create the React app component that will update as messages arrive
    const App = ({ debug }: { debug: boolean }) => {
      const { exit } = useApp();
      const [statusText, setStatusText] = React.useState<string>(
        "Initializing Claude...",
      );
      const [isProcessing, setIsProcessing] = React.useState<boolean>(true);
      const [reviewContent, setReviewContent] = React.useState<string>("");
      const [usage, setUsage] = React.useState<
        { input_tokens: number; output_tokens: number } | undefined
      >();
      const [cost, setCost] = React.useState<
        { total_cost: number } | undefined
      >();
      const [debugEntries, setDebugEntries] = React.useState<DebugLogEntry[]>(
        [],
      );

      React.useEffect(() => {
        // Start the Claude query in the background
        const controller = new AbortController();
        let accumulatedContent = "";

        const addDebugEntry = (
          type: DebugLogEntry["type"],
          content: string,
        ) => {
          if (debug) {
            setDebugEntries((prev) => [...prev, {
              timestamp: Date.now(),
              type,
              content,
            }]);
          }
        };

        (async () => {
          try {
            const response = query({
              abortController: controller,
              options: {
                permissionMode: "default",
                model: options.model,
                appendSystemPrompt: additionalSystemPrompt,
              },
              prompt: diff,
            });

            for await (const msg of response) {
              switch (msg.type) {
                case "assistant": {
                  const content = msg.message.content || [];
                  let hasText = false;
                  for (const block of content) {
                    if (block.type === "text") {
                      // Accumulate text content
                      accumulatedContent += block.text;
                      setReviewContent(accumulatedContent);
                      hasText = true;
                    } else if (block.type === "tool_use") {
                      // Update status for tool usage
                      setStatusText(`Using tool: ${block.name}`);
                      const toolInfo = block.input
                        ? `${block.name} (${
                          JSON.stringify(block.input).slice(0, 100)
                        }...)`
                        : block.name;
                      addDebugEntry("tool_use", `Using tool: ${toolInfo}`);
                    }
                  }
                  if (hasText && debug) {
                    addDebugEntry("assistant", "Added text to review content");
                  }
                  break;
                }
                case "user": {
                  // Tool result - update status
                  setStatusText("Processing tool results...");
                  addDebugEntry("user", "Tool result received");
                  break;
                }
                case "system": {
                  // System messages - update status
                  setStatusText("System processing...");
                  // deno-lint-ignore no-explicit-any
                  const sysMsg = msg as any;
                  addDebugEntry(
                    "system",
                    sysMsg.error ? `Error: ${sysMsg.error}` : "System message",
                  );
                  break;
                }
                case "result": {
                  // Extract usage and cost info
                  // deno-lint-ignore no-explicit-any
                  const resultMsg = msg as any;
                  if (resultMsg.usage) {
                    setUsage(resultMsg.usage);
                  }
                  if (resultMsg.cost) {
                    setCost(resultMsg.cost);
                  }
                  setIsProcessing(false);
                  addDebugEntry(
                    "system",
                    `Review complete. Tokens: ${
                      resultMsg.usage?.input_tokens || 0
                    } in, ${resultMsg.usage?.output_tokens || 0} out`,
                  );
                  break;
                }
              }
            }
          } catch (error) {
            setStatusText(`Error: ${error}`);
            setIsProcessing(false);
          }
        })();

        return () => controller.abort();
      }, []);

      // Auto-exit when review is complete and token info is displayed
      React.useEffect(() => {
        if (!isProcessing && usage) {
          // Small delay to ensure UI updates are rendered
          const timer = setTimeout(() => exit(), 100);
          return () => clearTimeout(timer);
        }
      }, [isProcessing, usage, exit]);

      return (
        <Box flexDirection="column">
          <Text>
            <Text bold underline>Claude (Code Review)</Text>
            <Text>&#32;&mdash; using {options.model}</Text>
          </Text>
          <StatusLine isActive={isProcessing} statusText={statusText} />
          <ReviewContent content={reviewContent} usage={usage} cost={cost} />
          {debug && debugEntries.length > 0 && (
            <DebugLog entries={debugEntries} />
          )}
        </Box>
      );
    };

    // Render the app using Ink
    const { waitUntilExit } = render(<App debug={options.debug || false} />);
    await waitUntilExit();
  })
  .parse(Deno.args);
