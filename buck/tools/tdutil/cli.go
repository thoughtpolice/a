// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

const (
	// tdutilVersion is a monotonic counter, not a semantic version. It is
	// recorded in every base snapshot and checked when one is reused, because
	// a document's contents depend on this program's own behavior — which
	// attributes `targetAttributes` asks buck2 for, how repository paths are
	// derived, what a graph error means — and none of that is otherwise
	// observable in the document. Increment it whenever a change would make an
	// older snapshot describe the graph differently than a fresh collection
	// would; every existing snapshot is invalidated, which costs one cold
	// collection and is always the safe direction.
	tdutilVersion     = "2"
	defaultBaseRevset = "fork_point(trunk() | @)"
	helpText          = `Determine the Buck2 targets affected between two JJ revisions.

Usage:
  tdutil [OPTIONS] [BASE [HEAD [PATTERN...]]]
  tdutil [OPTIONS] PATTERN...

With no arguments, compares the fork point of trunk() and @ to @ over
depot//.... If the first positional argument contains ` + "`//`" + `, all positional
arguments are target patterns and the default revisions are used.

Options:
      --from REV              Base JJ revset (default: ` + defaultBaseRevset + `)
      --to REV                Head JJ revset (default: @)
  -u, --universe PATTERN      Add a Buck2 universe pattern (repeatable)
  -o, --output PATH           Write results to PATH instead of stdout
      --format FORMAT         text, json, or json-lines (default: text)
      --json                  Shorthand for --format json
      --depth N               Maximum reverse-dependency depth (roots are 0)
      --quick                 Single-snapshot mode: consult only the working
                              copy's Buck graph, with no base materialization.
                              Misses dependents of deleted targets and precise
                              definition-change detection; the head revision
                              must match the working-copy tree
      --snapshot-to PATH      Capture the head revision's graph as a reusable
                              base snapshot at PATH, then exit
      --snapshot-head-to PATH Also write the head graph this run collected as
                              a reusable base snapshot at PATH. Unlike
                              --snapshot-to it collects nothing extra, so a
                              run which determines targets can refresh the
                              snapshot for free. Never fails the run
      --base-snapshot PATH    Reuse a matching --snapshot-to document as the
                              base graph; falls back to full collection when
                              it does not match
      --buck COMMAND          Buck2 executable (default: buck2)
      --jj COMMAND            JJ executable (default: jj)
      --buck-arg ARG          Extra Buck2 argument (repeatable)
  -c, --config KEY=VALUE      Pass a Buck2 config value to graph queries
      --isolation-dir NAME    Inner Buck2 isolation directory (default: tdutil)
      --ignore-working-copy   Do not ask JJ to snapshot before resolving revsets
      --keep-workspaces       Retain temporary historical workspaces for debugging
      --no-head-in-place      Materialize the head revision in a temporary
                              workspace even when it is the working-copy commit
  -v, --verbose               Print progress details to stderr
  -h, --help                  Print this help
  -V, --version               Print the version
`
)

type outputFormat uint8

const (
	formatText outputFormat = iota
	formatJSON
	formatJSONLines
)

type cliArgs struct {
	base              string
	head              string
	universe          []string
	output            *string
	format            outputFormat
	depth             *int
	quick             bool
	snapshotTo        *string
	snapshotHeadTo    *string
	baseSnapshot      *string
	buck              string
	jj                string
	buckArgs          []string
	isolationDir      string
	ignoreWorkingCopy bool
	keepWorkspaces    bool
	noHeadInPlace     bool
	verbose           bool
}

type cliActionKind uint8

const (
	actionRun cliActionKind = iota
	actionHelp
	actionVersion
)

type cliAction struct {
	kind cliActionKind
	args cliArgs
}

func parseCLI(argv []string) (cliAction, error) {
	var base *string
	var head *string
	var universe []string
	var output *string
	format := formatText
	var depth *int
	quick := false
	var snapshotTo *string
	var snapshotHeadTo *string
	var baseSnapshot *string
	buck := "buck2"
	jj := "jj"
	var buckArgs []string
	isolationDir := "tdutil"
	ignoreWorkingCopy := false
	keepWorkspaces := false
	noHeadInPlace := false
	verbose := false
	var positional []string
	options := true

	for index := 0; index < len(argv); index++ {
		arg := argv[index]
		if options && arg == "--" {
			options = false
			continue
		}
		if !options || !strings.HasPrefix(arg, "-") || arg == "-" {
			positional = append(positional, arg)
			continue
		}

		flag := arg
		inline := ""
		hasInline := false
		if split := strings.IndexByte(arg, '='); split >= 0 {
			flag = arg[:split]
			inline = arg[split+1:]
			hasInline = true
		}
		value := func(name string) (string, error) {
			if hasInline {
				return inline, nil
			}
			index++
			if index >= len(argv) {
				return "", fmt.Errorf("%s requires a value", name)
			}
			return argv[index], nil
		}

		switch flag {
		case "-h", "--help":
			return cliAction{kind: actionHelp}, nil
		case "-V", "--version":
			return cliAction{kind: actionVersion}, nil
		case "--from":
			raw, err := value("--from")
			if err != nil {
				return cliAction{}, err
			}
			base = stringPointer(raw)
		case "--to":
			raw, err := value("--to")
			if err != nil {
				return cliAction{}, err
			}
			head = stringPointer(raw)
		case "-u", "--universe":
			raw, err := value("--universe")
			if err != nil {
				return cliAction{}, err
			}
			universe = append(universe, raw)
		case "-o", "--output":
			raw, err := value("--output")
			if err != nil {
				return cliAction{}, err
			}
			output = stringPointer(raw)
		case "--format":
			raw, err := value("--format")
			if err != nil {
				return cliAction{}, err
			}
			switch raw {
			case "text":
				format = formatText
			case "json":
				format = formatJSON
			case "json-lines", "jsonl":
				format = formatJSONLines
			default:
				return cliAction{}, fmt.Errorf("unknown output format `%s` (expected text, json, or json-lines)", raw)
			}
		case "--json":
			format = formatJSON
		case "--depth":
			raw, err := value("--depth")
			if err != nil {
				return cliAction{}, err
			}
			// Reserving the sign bit keeps the int conversion faithful. A value
			// parsed across the full width wraps negative, and a negative limit
			// silently stops propagation at the roots instead of reporting the
			// bad input.
			parsed, parseErr := strconv.ParseUint(raw, 10, strconv.IntSize-1)
			if parseErr != nil {
				return cliAction{}, fmt.Errorf("invalid --depth value `%s`", raw)
			}
			depth = intPointer(int(parsed))
		case "--quick":
			quick = true
		case "--snapshot-to":
			raw, err := value("--snapshot-to")
			if err != nil {
				return cliAction{}, err
			}
			snapshotTo = stringPointer(raw)
		case "--snapshot-head-to":
			raw, err := value("--snapshot-head-to")
			if err != nil {
				return cliAction{}, err
			}
			snapshotHeadTo = stringPointer(raw)
		case "--base-snapshot":
			raw, err := value("--base-snapshot")
			if err != nil {
				return cliAction{}, err
			}
			baseSnapshot = stringPointer(raw)
		case "--buck":
			raw, err := value("--buck")
			if err != nil {
				return cliAction{}, err
			}
			buck = raw
		case "--jj":
			raw, err := value("--jj")
			if err != nil {
				return cliAction{}, err
			}
			jj = raw
		case "--buck-arg":
			raw, err := value("--buck-arg")
			if err != nil {
				return cliAction{}, err
			}
			buckArgs = append(buckArgs, raw)
		case "-c", "--config":
			raw, err := value("--config")
			if err != nil {
				return cliAction{}, err
			}
			buckArgs = append(buckArgs, "-c", raw)
		case "--isolation-dir":
			raw, err := value("--isolation-dir")
			if err != nil {
				return cliAction{}, err
			}
			isolationDir = raw
		case "--ignore-working-copy":
			ignoreWorkingCopy = true
		case "--keep-workspaces":
			keepWorkspaces = true
		case "--no-head-in-place":
			noHeadInPlace = true
		case "-v", "--verbose":
			verbose = true
		default:
			return cliAction{}, fmt.Errorf("unknown option `%s`", flag)
		}
	}

	revisionsArePositional := base == nil && head == nil && len(positional) > 0 && !isTargetPattern(positional[0])
	if revisionsArePositional {
		base = stringPointer(positional[0])
		if len(positional) > 1 {
			head = stringPointer(positional[1])
		}
		if len(positional) > 2 {
			universe = append(universe, positional[2:]...)
		}
	} else {
		universe = append(universe, positional...)
	}

	if quick && noHeadInPlace {
		return cliAction{}, fmt.Errorf("--quick already analyzes the working copy in place; it cannot combine with --no-head-in-place")
	}
	if quick && baseSnapshot != nil {
		return cliAction{}, fmt.Errorf("--quick consults no base graph; it cannot combine with --base-snapshot")
	}
	if snapshotTo != nil {
		switch {
		case snapshotHeadTo != nil:
			return cliAction{}, fmt.Errorf("--snapshot-to and --snapshot-head-to both write the head graph; use one")
		case quick:
			return cliAction{}, fmt.Errorf("--snapshot-to is a standalone capture; it cannot combine with --quick")
		case baseSnapshot != nil:
			return cliAction{}, fmt.Errorf("--snapshot-to is a standalone capture; it cannot combine with --base-snapshot")
		case base != nil:
			return cliAction{}, fmt.Errorf("--snapshot-to captures a single revision; a base revset does not apply")
		case output != nil:
			return cliAction{}, fmt.Errorf("--snapshot-to writes the snapshot itself; --output does not apply")
		}
	}

	if len(universe) == 0 {
		universe = append(universe, "depot//...")
	}
	for _, pattern := range universe {
		if !isTargetPattern(pattern) {
			return cliAction{}, fmt.Errorf("invalid universe pattern `%s`: patterns must be cell-qualified and contain `//`", pattern)
		}
	}
	universe = normalizeUniverse(universe)

	result := cliArgs{
		base:              defaultBaseRevset,
		head:              "@",
		universe:          universe,
		output:            output,
		format:            format,
		depth:             depth,
		quick:             quick,
		snapshotTo:        snapshotTo,
		snapshotHeadTo:    snapshotHeadTo,
		baseSnapshot:      baseSnapshot,
		buck:              buck,
		jj:                jj,
		buckArgs:          buckArgs,
		isolationDir:      isolationDir,
		ignoreWorkingCopy: ignoreWorkingCopy,
		keepWorkspaces:    keepWorkspaces,
		noHeadInPlace:     noHeadInPlace,
		verbose:           verbose,
	}
	if base != nil {
		result.base = *base
	}
	if head != nil {
		result.head = *head
	}
	return cliAction{kind: actionRun, args: result}, nil
}

func isTargetPattern(value string) bool {
	return strings.Contains(value, "//")
}

// normalizeUniverse orders and deduplicates the requested patterns. Which
// patterns are queried decides the graph; the order they were spelled in does
// not. Normalizing here lets a base snapshot captured by one invocation match
// an otherwise identical invocation that listed the same patterns differently,
// which would otherwise be an unexplained cache miss.
//
// Buck configuration arguments deliberately get no such treatment: repeating a
// key is meaningful to buck2, so their order is part of their meaning.
func normalizeUniverse(patterns []string) []string {
	normalized := append([]string(nil), patterns...)
	slices.Sort(normalized)
	return slices.Compact(normalized)
}

func stringPointer(value string) *string {
	return &value
}

func intPointer(value int) *int {
	return &value
}
