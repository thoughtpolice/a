// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	tdutilVersion     = "0.1.0"
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
			parsed, parseErr := strconv.ParseUint(raw, 10, strconv.IntSize)
			if parseErr != nil {
				return cliAction{}, fmt.Errorf("invalid --depth value `%s`", raw)
			}
			depth = intPointer(int(parsed))
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

	if len(universe) == 0 {
		universe = append(universe, "depot//...")
	}
	for _, pattern := range universe {
		if !isTargetPattern(pattern) {
			return cliAction{}, fmt.Errorf("invalid universe pattern `%s`: patterns must be cell-qualified and contain `//`", pattern)
		}
	}

	result := cliArgs{
		base:              defaultBaseRevset,
		head:              "@",
		universe:          universe,
		output:            output,
		format:            format,
		depth:             depth,
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

func stringPointer(value string) *string {
	return &value
}

func intPointer(value int) *int {
	return &value
}
