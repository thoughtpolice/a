// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// 3p-osv verifies that depot's generic third-party packages have usable OSV
// metadata and checks those packages, pinned Wolfi APKs, Cargo.lock, and
// package-lock.json against osv.dev.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"slices"
	"sort"
	"strings"
	"syscall"
	"time"
)

const defaultOSVAPIBase = "https://api.osv.dev/v1"

type config struct {
	apiBase          string
	buckPath         string
	buckIsolationDir string
	cargoLockPath    string
	npmLockPath      string
	batchSize        int
	concurrency      int
	httpTimeout      time.Duration
}

var checkModes = []string{"all", "generic", "rust", "npm", "wolfi"}

func isCheckMode(value string) bool {
	return slices.Contains(checkModes, value)
}

func (c config) auditor() dependencyAuditor {
	return buckAuditor{path: c.buckPath, isolationDir: c.buckIsolationDir}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(realMain(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func realMain(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	cfg := config{}
	listTests := false
	runTest := false
	flags := flag.NewFlagSet("3p-osv", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&cfg.apiBase, "api-base", defaultOSVAPIBase, "OSV API base URL")
	flags.StringVar(&cfg.buckPath, "buck", "./buck/bin/buck2", "path to the Buck2 dotslash executable")
	flags.StringVar(&cfg.buckIsolationDir, "buck-isolation-dir", "buck2-3p-osv-tests", "Buck2 isolation directory used for metadata audits")
	flags.StringVar(&cfg.cargoLockPath, "cargo-lock", "buck/third-party/rust/Cargo.lock", "Cargo.lock to scan")
	flags.StringVar(&cfg.npmLockPath, "npm-lock", "buck/tests/osv.io/testdata/package-lock.json", "npm package-lock.json to scan")
	flags.IntVar(&cfg.batchSize, "batch-size", 100, "queries per OSV batch")
	flags.IntVar(&cfg.concurrency, "concurrency", 8, "maximum concurrent OSV requests")
	flags.DurationVar(&cfg.httpTimeout, "http-timeout", 60*time.Second, "timeout for each OSV request")
	flags.BoolVar(&listTests, "list-tests", false, "print the Buck2 test cases for the selected mode and exit")
	flags.BoolVar(&runTest, "run-test", false, "run the single Buck2 test case named by the trailing filter argument")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: 3p-osv [flags] [all|generic|rust|npm|wolfi] [lockfile]")
		fmt.Fprintln(stderr, "Checks all dependency sets when no mode is supplied.")
		fmt.Fprintln(stderr, "A trailing lockfile overrides the scanned file in rust and npm mode.")
		fmt.Fprintln(stderr, "Buck2 internal-runner protocol:")
		fmt.Fprintln(stderr, "  3p-osv -list-tests [mode]         print one \"test: <filter> <name>\" line per case")
		fmt.Fprintln(stderr, "  3p-osv -run-test [mode] <filter>  check one case and print \"result: ...\" lines")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if listTests && runTest {
		fmt.Fprintln(stderr, "ERROR: -list-tests and -run-test are mutually exclusive")
		return 2
	}
	if cfg.batchSize <= 0 || cfg.concurrency <= 0 || cfg.httpTimeout <= 0 {
		fmt.Fprintln(stderr, "ERROR: batch-size, concurrency, and http-timeout must be positive")
		return 2
	}
	if err := validateExceptions(); err != nil {
		fmt.Fprintf(stderr, "ERROR: %v\n", err)
		return 2
	}

	remaining := flags.Args()
	if runTest {
		// Buck2 appends the filter after any user-supplied arguments, so it is
		// the final positional; a leading mode token is tolerated and ignored
		// because the filter alone selects the case.
		if len(remaining) == 0 {
			fmt.Fprintln(stderr, "ERROR: -run-test requires a test filter argument")
			return 2
		}
		filter := remaining[len(remaining)-1]
		for _, extra := range remaining[:len(remaining)-1] {
			if !isCheckMode(extra) {
				fmt.Fprintf(stderr, "ERROR: unexpected argument %q before the test filter\n", extra)
				return 2
			}
		}
		return runHarnessTest(ctx, cfg, filter, stdout, stderr)
	}

	mode := "all"
	if len(remaining) > 0 {
		mode = remaining[0]
		remaining = remaining[1:]
	}
	if !isCheckMode(mode) {
		fmt.Fprintf(stderr, "ERROR: unknown check mode %q\n", mode)
		flags.Usage()
		return 2
	}
	if len(remaining) == 1 {
		switch mode {
		case "rust":
			cfg.cargoLockPath = remaining[0]
			remaining = nil
		case "npm":
			cfg.npmLockPath = remaining[0]
			remaining = nil
		}
	}
	if len(remaining) != 0 {
		fmt.Fprintln(stderr, "ERROR: too many positional arguments")
		flags.Usage()
		return 2
	}
	if listTests {
		writeTestListing(mode, stdout)
		return 0
	}

	violation, err := execute(ctx, cfg, mode, cfg.auditor(), stdout)
	if err != nil {
		fmt.Fprintf(stderr, "ERROR: %v\n", err)
		return 2
	}
	if violation {
		return 1
	}
	return 0
}

func execute(ctx context.Context, cfg config, mode string, auditor dependencyAuditor, output io.Writer) (bool, error) {
	subjects, err := collectSubjects(ctx, cfg, mode, auditor, output)
	if err != nil {
		return false, err
	}
	findings, err := queryFindings(ctx, cfg, subjects, output)
	if err != nil {
		return false, err
	}
	return writeReport(output, subjects, findings), nil
}

func validateExceptions() error {
	var problems []string
	for _, set := range exceptionSets {
		seen := make(map[string]struct{}, len(set.Items))
		for _, item := range set.Items {
			if item.ID == "" || item.Reason == "" {
				problems = append(problems, set.Label+" exception has an empty id or reason")
				continue
			}
			// The same advisory may legitimately appear in two ecosystems, so
			// duplicates are only rejected within one list.
			if _, duplicate := seen[item.ID]; duplicate {
				problems = append(problems, "duplicate "+set.Label+" exception "+item.ID)
			}
			seen[item.ID] = struct{}{}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("invalid exceptions: %s", strings.Join(problems, "; "))
	}
	return nil
}
