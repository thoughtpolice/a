// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// build-report summarizes Buck2 --build-report JSON output.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

const usageText = `build-report - Summarize Buck2 --build-report JSON output

USAGE:
  build-report [OPTIONS] <report.json>
  build-report [OPTIONS] -              read the report from stdin

INPUT:
  Raw reports written by 'buck2 build --build-report FILE' or
  'buck2 test --build-report FILE', or processed reports previously
  written by this tool with --format json.

OPTIONS:
  --format FORMAT   Output format: console (default), json, markdown
  --output FILE     Write to FILE instead of stdout
  --all             Never truncate failure detail in console output
  --no-color        Disable ANSI colors (NO_COLOR is also honored)
  --help            Show this help

EXIT STATUS:
  0  the report describes a successful build
  1  the report describes a failed build
  2  the report could not be read or the usage was invalid

EXAMPLES:
  buck2 build --build-report report.json //... ; build-report report.json
  buck2 test --build-report report.json //...  ; build-report report.json
  build-report --format markdown --output summary.md report.json
  build-report --format json report.json | jq .summary
`

type options struct {
	format     string
	outputPath string
	inputPath  string
	color      bool
	all        bool
}

func main() {
	os.Exit(realMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func realMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	opts, status := parseArguments(args, stdout, stderr)
	if status >= 0 {
		return status
	}

	data, err := readInput(opts.inputPath, stdin)
	if err != nil {
		fmt.Fprintf(stderr, "Error: %v\n", err)
		return 2
	}
	report, err := loadReport(data)
	if err != nil {
		fmt.Fprintf(stderr, "Error: %v\n", err)
		return 2
	}
	rendered, err := render(report, opts)
	if err != nil {
		fmt.Fprintf(stderr, "Error: %v\n", err)
		return 2
	}

	if opts.outputPath != "" {
		if err := os.WriteFile(opts.outputPath, []byte(rendered), 0o644); err != nil {
			fmt.Fprintf(stderr, "Error: %v\n", err)
			return 2
		}
		fmt.Fprintf(stdout, "Report written to %s\n", opts.outputPath)
	} else if _, err := io.WriteString(stdout, rendered); err != nil {
		fmt.Fprintf(stderr, "Error: write output: %v\n", err)
		return 2
	}

	if report.Build.Status != statusSuccess {
		return 1
	}
	return 0
}

// parseArguments parses flags and positionals. A status of -1 means
// proceed; any other value is the process exit code.
func parseArguments(args []string, stdout, stderr io.Writer) (options, int) {
	var opts options
	var noColor bool

	flags := flag.NewFlagSet("build-report", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() {}
	flags.StringVar(&opts.format, "format", "console", "")
	flags.StringVar(&opts.outputPath, "output", "", "")
	flags.BoolVar(&opts.all, "all", false, "")
	flags.BoolVar(&noColor, "no-color", false, "")

	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stdout, usageText)
			return opts, 0
		}
		fmt.Fprintln(stderr, "Run 'build-report --help' for usage.")
		return opts, 2
	}

	switch opts.format {
	case "console", "json", "markdown":
	default:
		fmt.Fprintf(stderr, "Error: unknown format %q (expected console, json, or markdown)\n", opts.format)
		return opts, 2
	}
	if flags.NArg() != 1 {
		fmt.Fprintln(stderr, "Error: expected exactly one build report file (or '-' for stdin)")
		fmt.Fprintln(stderr, "Run 'build-report --help' for usage.")
		return opts, 2
	}
	opts.inputPath = flags.Arg(0)
	// Mirror the NO_COLOR convention rather than sniffing for a terminal:
	// CI log viewers render ANSI colors, and deterministic output beats
	// guessing at the destination.
	opts.color = !noColor && os.Getenv("NO_COLOR") == "" && opts.outputPath == ""
	return opts, -1
}

func readInput(path string, stdin io.Reader) ([]byte, error) {
	if path == "-" {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return nil, fmt.Errorf("read stdin: %w", err)
		}
		return data, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func render(report *Report, opts options) (string, error) {
	switch opts.format {
	case "json":
		return report.marshalJSON()
	case "markdown":
		var builder strings.Builder
		renderMarkdown(&builder, report)
		return builder.String(), nil
	default:
		var builder strings.Builder
		renderConsole(&builder, report, opts.color, opts.all)
		return builder.String(), nil
	}
}
