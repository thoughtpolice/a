// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from "jsr:@std/cli";
import { bold, green, red, yellow, blue, dim } from "jsr:@std/fmt/colors";

// Raw Buck2 build report interfaces
interface BuildOutput {
  [key: string]: string[];
}

interface ConfiguredResult {
  errors: string[];
  success: string;
  outputs: BuildOutput;
  other_outputs: BuildOutput;
  configured_graph_size: number;
}

interface BuildResult {
  success: string;
  outputs: BuildOutput;
  other_outputs: BuildOutput;
  configured_graph_size: number;
  configured: Record<string, ConfiguredResult>;
  errors: string[];
}

interface RawBuildReport {
  trace_id: string;
  success: boolean;
  results: Record<string, BuildResult>;
  failures: Record<string, unknown>;
  project_root: string;
  truncated: boolean;
  strings: Record<string, string>;
}

// Processed/unified report format (source of truth)
interface ProcessedBuildReport {
  format_version: string;
  generated_at: string;
  build_metadata: {
    build_id: string;
    status: "SUCCESS" | "FAILED";
    project_root: string;
    truncated: boolean;
  };
  summary: {
    total_targets: number;
    succeeded: number;
    failed: number;
    success_rate: string;
  };
  graph_analysis: {
    total_graph_nodes: number;
    average_graph_size: number;
    largest_dependency_graphs: Array<{
      target: string;
      nodes: number;
    }>;
  };
  target_breakdown: {
    by_type: Array<{
      type: string;
      count: number;
      percentage: string;
    }>;
    by_cell: Array<{
      cell: string;
      count: number;
      percentage: string;
    }>;
  };
  failed_targets: Array<{
    target: string;
    errors: string[];
  }>;
}

// Legacy interface for backward compatibility
interface TargetStats {
  total: number;
  succeeded: number;
  failed: number;
  byType: Record<string, number>;
  byCell: Record<string, number>;
  largestGraphs: Array<{ target: string; size: number }>;
  totalGraphSize: number;
  avgGraphSize: number;
  failedTargets: Array<{ target: string; errors: string[] }>;
}

function isProcessedReport(data: any): data is ProcessedBuildReport {
  return data && 
         data.format_version && 
         data.build_metadata && 
         data.summary && 
         data.graph_analysis && 
         data.target_breakdown && 
         data.failed_targets !== undefined;
}

function convertRawToProcessed(report: RawBuildReport): ProcessedBuildReport {
  const stats = analyzeTargets(report.results);
  
  return {
    format_version: "1.0.0",
    generated_at: new Date().toISOString(),
    build_metadata: {
      build_id: report.trace_id,
      status: report.success ? "SUCCESS" : "FAILED",
      project_root: report.project_root,
      truncated: report.truncated,
    },
    summary: {
      total_targets: stats.total,
      succeeded: stats.succeeded,
      failed: stats.failed,
      success_rate: ((stats.succeeded / stats.total) * 100).toFixed(1) + "%",
    },
    graph_analysis: {
      total_graph_nodes: stats.totalGraphSize,
      average_graph_size: stats.avgGraphSize,
      largest_dependency_graphs: stats.largestGraphs.slice(0, 10).map(g => ({
        target: g.target,
        nodes: g.size,
      })),
    },
    target_breakdown: {
      by_type: Object.entries(stats.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({
          type,
          count,
          percentage: ((count / stats.total) * 100).toFixed(1) + "%",
        })),
      by_cell: Object.entries(stats.byCell)
        .sort((a, b) => b[1] - a[1])
        .map(([cell, count]) => ({
          cell,
          count,
          percentage: ((count / stats.total) * 100).toFixed(1) + "%",
        })),
    },
    failed_targets: stats.failedTargets.map(f => ({
      target: f.target,
      errors: f.errors,
    })),
  };
}

function convertProcessedToStats(report: ProcessedBuildReport): TargetStats {
  // Convert processed report back to legacy TargetStats format for output functions
  const byType: Record<string, number> = {};
  const byCell: Record<string, number> = {};
  
  for (const item of report.target_breakdown.by_type) {
    byType[item.type] = item.count;
  }
  
  for (const item of report.target_breakdown.by_cell) {
    byCell[item.cell] = item.count;
  }
  
  return {
    total: report.summary.total_targets,
    succeeded: report.summary.succeeded,
    failed: report.summary.failed,
    byType,
    byCell,
    largestGraphs: report.graph_analysis.largest_dependency_graphs.map(g => ({
      target: g.target,
      size: g.nodes,
    })),
    totalGraphSize: report.graph_analysis.total_graph_nodes,
    avgGraphSize: report.graph_analysis.average_graph_size,
    failedTargets: report.failed_targets,
  };
}

function analyzeTargets(results: Record<string, BuildResult>): TargetStats {
  const stats: TargetStats = {
    total: 0,
    succeeded: 0,
    failed: 0,
    byType: {},
    byCell: {},
    largestGraphs: [],
    totalGraphSize: 0,
    avgGraphSize: 0,
    failedTargets: [],
  };

  const graphSizes: Array<{ target: string; size: number }> = [];

  for (const [target, result] of Object.entries(results)) {
    stats.total++;
    
    if (result.success === "SUCCESS") {
      stats.succeeded++;
    } else {
      stats.failed++;
      stats.failedTargets.push({ target, errors: result.errors });
    }

    // Extract cell name (first part before //)
    const cellMatch = target.match(/^([^/]+)\/\//);
    const cell = cellMatch ? cellMatch[1] : "unknown";
    stats.byCell[cell] = (stats.byCell[cell] || 0) + 1;

    // Extract target type (last part after :)
    const typeMatch = target.match(/:([^:]+)$/);
    if (typeMatch) {
      const targetType = typeMatch[1];
      // Group by common patterns
      let category = "other";
      if (targetType.endsWith(".exe")) {
        category = "executable";
      } else if (targetType.includes("test") || targetType.includes("check")) {
        category = "test";
      } else if (targetType.includes("lib")) {
        category = "library";
      } else if (targetType.includes("platform") || targetType.includes("-linux-") || 
                 targetType.includes("-macos-") || targetType.includes("-windows-") ||
                 targetType.includes("-uefi")) {
        category = "platform";
      } else if (targetType.includes("image") || targetType.includes("oci")) {
        category = "container";
      }
      stats.byType[category] = (stats.byType[category] || 0) + 1;
    }

    // Track graph sizes
    const graphSize = result.configured_graph_size;
    stats.totalGraphSize += graphSize;
    graphSizes.push({ target, size: graphSize });
  }

  // Calculate average
  stats.avgGraphSize = stats.total > 0 ? Math.round(stats.totalGraphSize / stats.total) : 0;

  // Find largest graphs
  graphSizes.sort((a, b) => b.size - a.size);
  stats.largestGraphs = graphSizes.slice(0, 10);

  return stats;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

function printReport(processedReport: ProcessedBuildReport, format: string) {
  if (format === "json") {
    console.log(JSON.stringify(processedReport, null, 2));
    return;
  }

  // Convert to legacy format for terminal output
  const stats = convertProcessedToStats(processedReport);
  const report = processedReport.build_metadata;

  // Console output
  console.log(bold("\n📊 Buck2 Build Report"));
  console.log(dim("─".repeat(50)));
  
  console.log(`\n${bold("Build ID:")} ${blue(report.build_id)}`);
  console.log(`${bold("Status:")} ${report.status === "SUCCESS" ? green("✓ SUCCESS") : red("✗ FAILED")}`);
  console.log(`${bold("Project:")} ${report.project_root}`);
  
  console.log(bold("\n📈 Summary"));
  console.log(dim("─".repeat(50)));
  
  const successRate = (stats.succeeded / stats.total * 100).toFixed(1);
  console.log(`Total targets: ${bold(stats.total.toString())}`);
  console.log(`Succeeded: ${green(stats.succeeded.toString())} (${successRate}%)`);
  if (stats.failed > 0) {
    console.log(`Failed: ${red(stats.failed.toString())}`);
  }
  console.log(`Average graph size: ${stats.avgGraphSize} nodes`);
  console.log(`Total graph nodes: ${stats.totalGraphSize.toLocaleString()}`);
  
  console.log(bold("\n🎯 Target Types"));
  console.log(dim("─".repeat(50)));
  
  const sortedTypes = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    const percentage = (count / stats.total * 100).toFixed(1);
    console.log(`${type.padEnd(15)} ${count.toString().padStart(4)} (${percentage}%)`);
  }
  
  if (Object.keys(stats.byCell).length > 1) {
    console.log(bold("\n📦 Cells"));
    console.log(dim("─".repeat(50)));
    
    const sortedCells = Object.entries(stats.byCell).sort((a, b) => b[1] - a[1]);
    for (const [cell, count] of sortedCells) {
      const percentage = (count / stats.total * 100).toFixed(1);
      console.log(`${cell.padEnd(15)} ${count.toString().padStart(4)} (${percentage}%)`);
    }
  }
  
  console.log(bold("\n📏 Largest Dependency Graphs"));
  console.log(dim("─".repeat(50)));
  
  for (const { target, size } of stats.largestGraphs.slice(0, 5)) {
    // Shorten long target names
    let displayTarget = target;
    if (target.length > 60) {
      const parts = target.split("//");
      const lastPart = parts[parts.length - 1];
      if (lastPart.length > 40) {
        displayTarget = `${parts[0]}//.../...${lastPart.slice(-30)}`;
      }
    }
    console.log(`${size.toString().padStart(5)} nodes  ${dim(displayTarget)}`);
  }

  // Failed targets
  if (stats.failed > 0) {
    console.log(bold(`\n❌ Failed Targets`));
    console.log(dim("─".repeat(50)));
    
    for (const failedTarget of stats.failedTargets) {
      console.log(red(`• ${failedTarget.target}`));
      if (failedTarget.errors.length > 0) {
        for (const error of failedTarget.errors) {
          console.log(`  ${dim(error)}`);
        }
      }
    }
  }

  console.log("\n");
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["format", "output"],
    boolean: ["help"],
    default: {
      format: "console",
    },
  });

  if (args.help) {
    console.log(`
${bold("buck2-report")} - Analyze Buck2 build reports and generate summaries

${bold("USAGE:")}
  buck2-report [OPTIONS] <input-file.json>

${bold("INPUT FORMATS:")}
  - Raw Buck2 build reports (from --build-report flag)
  - Processed JSON summaries (from previous buck2-report runs)

${bold("OPTIONS:")}
  --format <format>  Output format: console (default), json, markdown
  --output <file>    Write output to file instead of stdout
  --help             Show this help message

${bold("ROUND-TRIP SUPPORT:")}
  The JSON format can be used as both input and output, enabling:
  - Store processed reports for later analysis
  - Convert between different output formats
  - Database storage and retrieval workflows

${bold("EXAMPLES:")}
  # Generate console report from raw Buck2 output
  buck2 build --build-report raw-report.json //... && buck2-report raw-report.json

  # Process and save as JSON for later use
  buck2-report --format json --output processed.json raw-report.json

  # Generate markdown from previously processed JSON
  buck2-report --format markdown --output summary.md processed.json

  # Round-trip: JSON -> JSON (re-process with updated timestamp)
  buck2-report --format json --output updated.json processed.json
`);
    Deno.exit(0);
  }

  const reportFile = args._[0] as string;
  if (!reportFile) {
    console.error(red("Error: No build report file specified"));
    console.error("Run with --help for usage information");
    Deno.exit(1);
  }

  try {
    const content = await Deno.readTextFile(reportFile);
    const data = JSON.parse(content);
    
    let processedReport: ProcessedBuildReport;
    
    // Detect input type and convert to unified format
    if (isProcessedReport(data)) {
      // Input is already a processed report - use as-is
      processedReport = data;
    } else {
      // Input is a raw Buck2 build report - convert it
      const rawReport = data as RawBuildReport;
      processedReport = convertRawToProcessed(rawReport);
    }
    
    if (args.output) {
      // Generate output to file
      let output: string;
      if (args.format === "json") {
        output = JSON.stringify(processedReport, null, 2);
      } else if (args.format === "markdown") {
        output = await generateMarkdown(processedReport);
      } else {
        // For console format, generate a text version
        output = generateConsoleText(processedReport);
      }
      
      await Deno.writeTextFile(args.output, output);
      console.log(green(`✓ Report written to ${args.output}`));
    } else {
      printReport(processedReport, args.format);
    }
    
    // Exit with error if build failed
    if (processedReport.build_metadata.status === "FAILED") {
      Deno.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(red(`Error: ${error.message}`));
    } else {
      console.error(red(`Error: ${String(error)}`));
    }
    Deno.exit(1);
  }
}

async function generateMarkdown(processedReport: ProcessedBuildReport): Promise<string> {
  const lines: string[] = [];
  
  lines.push("# Buck2 Build Report");
  lines.push("");
  lines.push(`> Generated at ${processedReport.generated_at}`);
  lines.push("");
  
  // Build metadata
  lines.push("## Build Metadata");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|-------|-------|");
  lines.push(`| Build ID | \`${processedReport.build_metadata.build_id}\` |`);
  lines.push(`| Status | ${processedReport.build_metadata.status === "SUCCESS" ? "✅ SUCCESS" : "❌ FAILED"} |`);
  lines.push(`| Project Root | \`${processedReport.build_metadata.project_root}\` |`);
  lines.push(`| Report Truncated | ${processedReport.build_metadata.truncated ? "Yes" : "No"} |`);
  lines.push("");
  
  // Summary statistics
  lines.push("## Summary Statistics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Targets | **${processedReport.summary.total_targets}** |`);
  lines.push(`| Succeeded | ${processedReport.summary.succeeded} (${processedReport.summary.success_rate}) |`);
  lines.push(`| Failed | ${processedReport.summary.failed} |`);
  lines.push(`| Success Rate | **${processedReport.summary.success_rate}** |`);
  lines.push("");
  
  // Graph analysis
  lines.push("## Dependency Graph Analysis");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Graph Nodes | ${processedReport.graph_analysis.total_graph_nodes.toLocaleString()} |`);
  lines.push(`| Average Graph Size | ${processedReport.graph_analysis.average_graph_size} nodes |`);
  lines.push("");
  
  // Target type breakdown
  lines.push("## Target Type Breakdown");
  lines.push("");
  lines.push("| Type | Count | Percentage | Bar |");
  lines.push("|------|-------|------------|-----|");
  
  for (const item of processedReport.target_breakdown.by_type) {
    const bar = generateBar(item.count, processedReport.summary.total_targets, 20);
    lines.push(`| ${item.type} | ${item.count} | ${item.percentage} | ${bar} |`);
  }
  lines.push("");
  
  // Cell breakdown if multiple cells
  if (processedReport.target_breakdown.by_cell.length > 1) {
    lines.push("## Cell Distribution");
    lines.push("");
    lines.push("| Cell | Count | Percentage | Bar |");
    lines.push("|------|-------|------------|-----|");
    
    for (const item of processedReport.target_breakdown.by_cell) {
      const bar = generateBar(item.count, processedReport.summary.total_targets, 20);
      lines.push(`| ${item.cell} | ${item.count} | ${item.percentage} | ${bar} |`);
    }
    lines.push("");
  }
  
  // Largest dependency graphs
  lines.push("## Top 10 Largest Dependency Graphs");
  lines.push("");
  lines.push("| Rank | Target | Graph Size |");
  lines.push("|------|--------|------------|");
  
  const topGraphs = processedReport.graph_analysis.largest_dependency_graphs.slice(0, 10);
  for (let i = 0; i < topGraphs.length; i++) {
    const { target, nodes } = topGraphs[i];
    lines.push(`| ${i + 1} | \`${target}\` | ${nodes.toLocaleString()} nodes |`);
  }
  lines.push("");
  
  // Failed targets section
  if (processedReport.summary.failed > 0) {
    lines.push("## Failed Targets");
    lines.push("");
    lines.push(`Total failed: ${processedReport.summary.failed}`);
    lines.push("");
    
    for (const failedTarget of processedReport.failed_targets) {
      lines.push(`### \`${failedTarget.target}\``);
      lines.push("");
      if (failedTarget.errors.length > 0) {
        lines.push("**Errors:**");
        for (const error of failedTarget.errors) {
          lines.push(`- ${error}`);
        }
      } else {
        lines.push("*No error details available*");
      }
      lines.push("");
    }
  }
  
  return lines.join("\n");
}

function generateBar(value: number, total: number, width: number): string {
  const percentage = value / total;
  const filled = Math.round(percentage * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}


function generateConsoleText(processedReport: ProcessedBuildReport): string {
  const lines: string[] = [];
  
  lines.push("\n📊 Buck2 Build Report");
  lines.push("─".repeat(50));
  
  lines.push(`\nBuild ID: ${processedReport.build_metadata.build_id}`);
  lines.push(`Status: ${processedReport.build_metadata.status === "SUCCESS" ? "✓ SUCCESS" : "✗ FAILED"}`);
  lines.push(`Project: ${processedReport.build_metadata.project_root}`);
  
  lines.push("\n📈 Summary");
  lines.push("─".repeat(50));
  
  lines.push(`Total targets: ${processedReport.summary.total_targets}`);
  lines.push(`Succeeded: ${processedReport.summary.succeeded} (${processedReport.summary.success_rate})`);
  if (processedReport.summary.failed > 0) {
    lines.push(`Failed: ${processedReport.summary.failed}`);
  }
  lines.push(`Average graph size: ${processedReport.graph_analysis.average_graph_size} nodes`);
  lines.push(`Total graph nodes: ${processedReport.graph_analysis.total_graph_nodes.toLocaleString()}`);
  
  lines.push("\n🎯 Target Types");
  lines.push("─".repeat(50));
  
  for (const item of processedReport.target_breakdown.by_type) {
    lines.push(`${item.type.padEnd(15)} ${item.count.toString().padStart(4)} (${item.percentage})`);
  }
  
  if (processedReport.target_breakdown.by_cell.length > 1) {
    lines.push("\n📦 Cells");
    lines.push("─".repeat(50));
    
    for (const item of processedReport.target_breakdown.by_cell) {
      lines.push(`${item.cell.padEnd(15)} ${item.count.toString().padStart(4)} (${item.percentage})`);
    }
  }
  
  lines.push("\n📏 Largest Dependency Graphs");
  lines.push("─".repeat(50));
  
  for (const { target, nodes } of processedReport.graph_analysis.largest_dependency_graphs.slice(0, 5)) {
    // Shorten long target names
    let displayTarget = target;
    if (target.length > 60) {
      const parts = target.split("//");
      const lastPart = parts[parts.length - 1];
      if (lastPart.length > 40) {
        displayTarget = `${parts[0]}//.../...${lastPart.slice(-30)}`;
      }
    }
    lines.push(`${nodes.toString().padStart(5)} nodes  ${displayTarget}`);
  }

  // Failed targets
  if (processedReport.summary.failed > 0) {
    lines.push(`\n❌ Failed Targets`);
    lines.push("─".repeat(50));
    
    for (const failedTarget of processedReport.failed_targets) {
      lines.push(`• ${failedTarget.target}`);
      if (failedTarget.errors.length > 0) {
        for (const error of failedTarget.errors) {
          lines.push(`  ${error}`);
        }
      }
    }
  }

  lines.push("\n");
  return lines.join("\n");
}

if (import.meta.main) {
  await main();
}
