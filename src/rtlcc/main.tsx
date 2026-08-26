// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file jsx-curly-braces

import React, { useEffect, useState } from "react";
import { Box, render, Text } from "ink";

import { Command, EnumType } from "@cliffy/command";

import * as util from "./util.ts";
import type { CriticalPath, Report } from "./lib.ts";
import { createBuildClient } from "./worker-client.ts";

// -------------------------------------------------------------------------------------------------
// Types

interface TimingEntry {
  label: string;
  duration: number; // in milliseconds
}

interface PhaseProgressProps {
  label: string;
  elapsed: number;
}

interface ExecutionTimelineProps {
  entries: TimingEntry[];
}

interface ReportDisplayProps {
  report: Report;
  timingEntries: TimingEntry[];
  bitstreamSize: number;
  outputFile: string;
  memoryUsage: Deno.MemoryUsage;
}

// -------------------------------------------------------------------------------------------------
// Spinner frames (Braille patterns)

// Color palette for timeline phases
const PHASE_COLORS = [
  "green",
  "yellow",
  "cyan",
  "magenta",
  "blue",
  "red",
] as const;

// -------------------------------------------------------------------------------------------------
// Utility functions

/**
 * Format bytes into human-readable string
 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/**
 * Horizontal separator line
 */
const Separator = () => <Text dimColor>{"─".repeat(70)}</Text>;

// -------------------------------------------------------------------------------------------------
// Components

/**
 * Soft pink/purple palette for continuous smooth shimmer - acts as a progress indicator
 * Uses pink, purple, and muted yellow tones with many gradations for smoothness
 */
const SHIMMER_COLORS = [
  "magenta",
  "magentaBright",
  "magenta",
  "magentaBright",
  "blue",
  "blueBright",
  "blue",
  "blueBright",
  "cyan",
  "cyanBright",
  "cyan",
  "cyanBright",
  "yellow",
  "yellow",
  "yellow",
  "yellow",
] as const;

/**
 * Progressive status display showing step chain with continuous warm shimmer on current step
 */
const ProgressiveStatus = (props: {
  completedSteps: string[];
  currentStep: string | null;
}) => {
  const { completedSteps, currentStep } = props;
  const [shimmerOffset, setShimmerOffset] = useState(0);

  useEffect(() => {
    if (!currentStep) return;

    let animationTimer: ReturnType<typeof setInterval> | null = null;
    let isRunning = true;

    const runShimmerCycle = () => {
      if (!isRunning) return;

      // Shimmer animation over 1.5 seconds
      const totalSteps = SHIMMER_COLORS.length;
      const shimmerSpeed = 1500 / totalSteps; // 1.5 seconds total duration
      let currentOffset = 0;

      animationTimer = setInterval(() => {
        currentOffset = (currentOffset + 1) % SHIMMER_COLORS.length;
        setShimmerOffset(currentOffset);

        // When we complete one full cycle, pause for 0.5 seconds
        if (currentOffset === 0) {
          if (animationTimer !== null) {
            clearInterval(animationTimer);
            animationTimer = null;
          }
          setTimeout(() => {
            if (isRunning) runShimmerCycle();
          }, 500);
        }
      }, shimmerSpeed);
    };

    // Start the first cycle
    runShimmerCycle();

    return () => {
      isRunning = false;
      if (animationTimer !== null) {
        clearInterval(animationTimer);
      }
    };
  }, [currentStep]);

  const renderShimmerText = (text: string): React.ReactNode => {
    const chars = text.split("").map((char: string, idx: number) => {
      const colorIdx = (idx + shimmerOffset) % SHIMMER_COLORS.length;
      const color = SHIMMER_COLORS[colorIdx];
      return (
        <Box key={`char-${idx}`}>
          <Text color={color}>{char}</Text>
        </Box>
      );
    });

    return (
      <Box>
        <Text>{" "}</Text>
        {chars}
        <Text>{" "}</Text>
      </Box>
    );
  };

  return (
    <Box>
      {completedSteps.map((step: string, idx: number) => {
        // Only show arrow if there's another step after this one (either completed or current)
        const hasNextStep = (idx < completedSteps.length - 1) ||
          currentStep !== null;
        return (
          <Box key={`step-${idx}`}>
            <Text dimColor>{" "}{step}{" "}</Text>
            {hasNextStep && <Text dimColor>→</Text>}
          </Box>
        );
      })}
      {currentStep && renderShimmerText(currentStep)}
    </Box>
  );
};

/**
 * Displays segmented bar chart of execution timeline
 */
const ExecutionTimeline = (props: ExecutionTimelineProps) => {
  const { entries } = props;
  if (entries.length === 0) return null;

  const totalTime = entries.reduce(
    (sum: number, e: TimingEntry) => sum + e.duration,
    0,
  );
  const totalSec = (totalTime / 1000).toFixed(2);

  const barWidth = 60;
  const segments = entries.map((entry: TimingEntry, i: number) => {
    const percent = (entry.duration / totalTime) * 100;
    const segmentWidth = Math.round((percent / 100) * barWidth);
    const color = PHASE_COLORS[i % PHASE_COLORS.length];
    return { width: segmentWidth, color };
  });

  // Render bar segments
  const barSegments = segments.map((
    seg: { width: number; color: typeof PHASE_COLORS[number] },
    i: number,
  ) => (
    <Box key={`seg-${i}`}>
      <Text color={seg.color}>
        {"█".repeat(seg.width)}
      </Text>
    </Box>
  ));

  // Calculate remaining empty space
  const usedWidth = segments.reduce(
    (sum: number, seg: { width: number; color: typeof PHASE_COLORS[number] }) =>
      sum + seg.width,
    0,
  );
  const emptyWidth = Math.max(0, barWidth - usedWidth);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Execution Time Breakdown</Text>
      <Box marginTop={1}>
        <Text>{" "}</Text>
        {barSegments}
        <Text>{"░".repeat(emptyWidth)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Total: {totalSec}s</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {entries.map((entry: TimingEntry, i: number) => {
          const durationSec = (entry.duration / 1000).toFixed(2);
          const percent = ((entry.duration / totalTime) * 100).toFixed(1);
          const color = PHASE_COLORS[i % PHASE_COLORS.length];
          const space = " "; // NOTE (aseipp): avoid helix highlighting glitch :(
          return (
            <Box key={`entry-${i}`}>
              <Text color={color}>{" "}█</Text>
              <Text>{space}{entry.label}: {durationSec}s ({percent}%)</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

/**
 * Displays clock frequency results
 */
const ClockFrequencies = (props: { fmax: Report["fmax"] }) => {
  const { fmax } = props;
  const entries = Object.entries(fmax);
  if (entries.length === 0) {
    return <Text dimColor>No clock constraints found</Text>;
  }

  return (
    <Box flexDirection="column">
      {entries.map(([clock, data]) => {
        const achieved = data.achieved.toFixed(2);
        const constraint = data.constraint.toFixed(2);
        const passed = data.achieved >= data.constraint;
        const checkMark = passed ? "✓" : "✗";
        const status = passed ? "PASS" : "FAIL";
        const statusColor = passed ? "green" : "red";

        return (
          <Box key={clock} marginLeft={2}>
            <Text color={statusColor}>{checkMark}</Text>
            <Text>{" "}{clock.padEnd(20)}</Text>
            <Text color="yellow">{achieved.padStart(8)}</Text>
            <Text>MHz /</Text>
            <Text>{constraint.padStart(8)}</Text>
            <Text>MHz [</Text>
            <Text color={statusColor}>{status}</Text>
            <Text>]</Text>
          </Box>
        );
      })}
    </Box>
  );
};

/**
 * Displays critical timing paths
 */
const CriticalPathsDisplay = (props: { paths: CriticalPath[] }) => {
  const { paths } = props;
  if (!paths || paths.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Critical Paths:</Text>
      {paths.map((critPath: CriticalPath, idx: number) => {
        const totalDelay = critPath.path.reduce(
          (sum: number, p: CriticalPath["path"][number]) => sum + p.delay,
          0,
        );
        const delayNs = totalDelay.toFixed(3);
        const freqMhz = (1000 / totalDelay).toFixed(2);

        return (
          <Box key={`path-${idx}`} flexDirection="column" marginLeft={2}>
            <Text color="cyan">
              {critPath.from} → {critPath.to}
            </Text>
            <Box marginLeft={2}>
              <Text>{delayNs} ns ({freqMhz} MHz)</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};

/**
 * Creates a horizontal bar for resource utilization
 */
const createUtilizationBar = (percent: number, width: number): string => {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
};

/**
 * Gets color for utilization percentage
 */
const getUtilizationColor = (percent: number): "green" | "yellow" | "red" => {
  if (percent < 50) return "green";
  if (percent < 80) return "yellow";
  return "red";
};

/**
 * Displays resource utilization with bar charts - compact single-line format
 */
const ResourceUtilization = (props: { utilization: Report["utilization"] }) => {
  const { utilization } = props;

  interface UtilEntry {
    used: number;
    available: number;
    utilization: number;
  }

  const entries = Object.entries(utilization)
    .filter(
      (
        entry,
      ): entry is [
        string,
        UtilEntry,
      ] => {
        const val = entry[1] as {
          used: number;
          available: number;
          utilization: number;
        };
        return val.used > 0;
      },
    )
    .map(([k, v]) => {
      const util = Math.round((v.used / v.available) * 10000) / 100;
      return [k, { ...v, utilization: util }] as const;
    })
    .sort((a, b) => b[1].utilization - a[1].utilization);

  if (entries.length === 0) {
    return <Text dimColor>No resources used</Text>;
  }

  const barWidth = 24;

  return (
    <Box flexDirection="column">
      {entries.map(([resource, data]) => {
        const bar = createUtilizationBar(data.utilization, barWidth);
        const percent = data.utilization.toFixed(1).padStart(5);
        const color = getUtilizationColor(data.utilization);
        const used = data.used.toString().padStart(5);
        const avail = data.available.toString().padStart(5);

        return (
          <Box key={resource} marginLeft={2}>
            <Text>{resource.padEnd(12)}</Text>
            <Text color={color}>{" "}{bar}{" "}</Text>
            <Text>{percent}%</Text>
            <Text dimColor>({used} / {avail})</Text>
          </Box>
        );
      })}
    </Box>
  );
};

/**
 * Main report display component
 */
const ReportDisplay = (props: ReportDisplayProps) => {
  const { report, timingEntries, bitstreamSize, outputFile, memoryUsage } =
    props;

  const totalTime = timingEntries.reduce(
    (sum: number, e: TimingEntry) => sum + e.duration,
    0,
  );
  const totalSec = (totalTime / 1000).toFixed(2);

  // Format memory usage
  const heapUsedMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotalMB = (memoryUsage.heapTotal / 1024 / 1024).toFixed(1);
  const rssMB = (memoryUsage.rss / 1024 / 1024).toFixed(1);

  return (
    <Box flexDirection="column">
      <ExecutionTimeline entries={timingEntries} />

      <Box marginTop={1}>
        <Separator />
      </Box>

      <Box marginTop={1}>
        <Text bold>Timing & Utilization Report</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Clock Frequencies:</Text>
        <ClockFrequencies fmax={report.fmax} />
      </Box>

      <CriticalPathsDisplay paths={report.criticalPaths} />

      <Box marginTop={1} flexDirection="column">
        <Text bold>Resource Utilization:</Text>
        <ResourceUtilization utilization={report.utilization} />
      </Box>

      <Box marginTop={1}>
        <Separator />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color="green">✓</Text>
          <Text>{" "}Build completed in{" "}</Text>
          <Text bold>{totalSec}s</Text>
        </Box>
        <Box>
          <Text>Output:</Text>
          <Text bold color="cyan">{" "}{outputFile}{" "}</Text>
          <Text>(</Text>
          <Text color="yellow">{formatBytes(bitstreamSize)}</Text>
          <Text>)</Text>
        </Box>
        <Box>
          <Text>Memory:</Text>
          <Text>{" "}Heap {" "}</Text>
          <Text color="cyan">{heapUsedMB} MB</Text>
          <Text>{" "}/ {heapTotalMB} MB</Text>
          <Text dimColor>{" "}(RSS: {rssMB} MB)</Text>
        </Box>
      </Box>
    </Box>
  );
};

// -------------------------------------------------------------------------------------------------
// Main Application Component

interface MainAppProps {
  dir: string;
  outputFile: string;
}

const MainApp = (props: MainAppProps) => {
  const { dir, outputFile } = props;
  const [currentPhase, setCurrentPhase] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [phaseStartTime, setPhaseStartTime] = useState<number>(0);
  const [_elapsed, setElapsed] = useState<number>(0);
  const [timingEntries, setTimingEntries] = useState<TimingEntry[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [bitstreamSize, setBitstreamSize] = useState<number>(0);
  const [memoryUsage, setMemoryUsage] = useState<Deno.MemoryUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    if (currentPhase && !completed) {
      const timer = setInterval(() => {
        setElapsed(performance.now() - phaseStartTime);
      }, 80);

      return () => clearInterval(timer);
    }
  }, [currentPhase, phaseStartTime, completed]);

  useEffect(() => {
    (async () => {
      try {
        const workerUrl = new URL("./worker.ts", import.meta.url).href;
        const builder = createBuildClient(workerUrl);

        let phaseStart = 0;

        const startPhase = (label: string) => {
          phaseStart = performance.now();
          setCurrentPhase(label);
          setPhaseStartTime(phaseStart);
          setElapsed(0);
        };

        const stopPhase = (label: string) => {
          const duration = performance.now() - phaseStart;
          setTimingEntries((
            prev: TimingEntry[],
          ) => [...prev, { label, duration }]);
          setCompletedSteps((prev: string[]) => [...prev, label]);
          setCurrentPhase(null);
        };

        startPhase("Preloading assets");
        await builder.preloadAllToolchains();
        stopPhase("Preloading assets");

        const inputTree = await util.walkDirectoryForTree(dir);

        startPhase("Synthesis");
        const synthTree = await builder.synthesize(inputTree, {
          args: ["synth.ys"],
        });
        stopPhase("Synthesis");

        startPhase("Place and route");
        const [pnrTree, pnrReport] = await builder.pnr(synthTree, {
          placer: "static",
          router: "router1",
        });
        stopPhase("Place and route");

        startPhase("Bitstream packing");
        const packTree = await builder.pack(pnrTree, {});
        const bitstreamData = packTree["design.bit"] as Uint8Array;
        await Deno.writeFile(outputFile, bitstreamData);
        stopPhase("Bitstream packing");

        builder.terminate();

        // Capture memory usage statistics
        const memStats = Deno.memoryUsage();

        setReport(pnrReport);
        setBitstreamSize(bitstreamData.length);
        setMemoryUsage(memStats);
        setCompleted(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setCompleted(true);
      }
    })();
  }, []);

  if (error) {
    return (
      <Box>
        <Text color="red">✗ Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {
        <ProgressiveStatus
          completedSteps={completedSteps}
          currentStep={currentPhase}
        />
      }
      {completed && report && memoryUsage && (
        <ReportDisplay
          report={report}
          timingEntries={timingEntries}
          bitstreamSize={bitstreamSize}
          outputFile={outputFile}
          memoryUsage={memoryUsage}
        />
      )}
    </Box>
  );
};

// -------------------------------------------------------------------------------------------------

const cxxrtl = new Command()
  .action(async (_options, ..._args) => {
    console.log("Running CXXRTL flow...");

    const workerUrl = new URL("./worker.ts", import.meta.url).href;
    const builder = createBuildClient(workerUrl);

    console.log("Preloading assets...");
    await builder.preloadAllToolchains();
    console.log("✓ Preloading assets");

    const sourceTree = await util.walkDirectoryForTree("cxxrtl");
    sourceTree["synth.ys"] = `
      read_slang blink.sv
      write_cxxrtl out/blink.cpp
      write_file out/cxxrtl/cxxrtl.h            +/include/backends/cxxrtl/runtime/cxxrtl/cxxrtl.h
      write_file out/cxxrtl/cxxrtl_replay.h     +/include/backends/cxxrtl/runtime/cxxrtl/cxxrtl_replay.h
      write_file out/cxxrtl/cxxrtl_time.h       +/include/backends/cxxrtl/runtime/cxxrtl/cxxrtl_time.h
      write_file out/cxxrtl/cxxrtl_vcd.h        +/include/backends/cxxrtl/runtime/cxxrtl/cxxrtl_vcd.h
      write_file out/cxxrtl/capi/cxxrtl_capi.h  +/include/backends/cxxrtl/runtime/cxxrtl/capi/cxxrtl_capi.h
      write_file out/main.cpp main.cpp
    `;

    console.log("Running Yosys...");
    const cxxTree = await builder.yosys(sourceTree, ["synth.ys"]);
    console.log("✓ Yosys synthesis");

    console.log("Running Clang++...");
    const finalTree = await builder.llvm("clang++", cxxTree, [
      "-O3",
      "-fno-exceptions",
      "-I.",
      "--output=out/sim.exe",
      "main.cpp",
    ]);
    console.log("✓ Clang++ compilation");
    await util.writeTreeToDirectory(finalTree, "/tmp/rtlcc-test");

    builder.terminate();
    console.log("Done!");
  });

// -------------------------------------------------------------------------------------------------

const LogLevelType = new EnumType(["debug", "info", "warn", "error"]);

await new Command()
  .name("macabre")
  .version("0.1.0")
  .description("Portable, determistic, push-button FPGA tooling")
  .type("log-level", LogLevelType)
  .env("DEBUG=<enable:boolean>", "Enable debug output.")
  .option("-d, --debug", "Enable debug output.")
  .option("-l, --log-level <level:log-level>", "Set log level.", {
    default: "info" as const,
  })
  .arguments("<dir:file> [out:file]")
  .action(async (_options, ...args) => {
    const dir = args[0];
    const dirInfo = await Deno.lstat(dir);
    if (!dirInfo.isDirectory) {
      console.error(`Provided project path '${dir}' is not a directory`);
      Deno.exit(1);
    }

    const outputFile = args[1] ?? "out.bit";

    // Render the React/Ink UI
    render(<MainApp dir={dir} outputFile={outputFile} />);
  })
  .command("cxxrtl", cxxrtl)
  .parse(Deno.args);
