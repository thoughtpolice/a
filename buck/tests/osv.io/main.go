// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// 3p-osv verifies that depot's generic third-party packages have usable OSV
// metadata and checks both those packages and Cargo.lock against osv.dev.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
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
	batchSize        int
	concurrency      int
	httpTimeout      time.Duration
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(realMain(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func realMain(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	cfg := config{}
	flags := flag.NewFlagSet("3p-osv", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&cfg.apiBase, "api-base", defaultOSVAPIBase, "OSV API base URL")
	flags.StringVar(&cfg.buckPath, "buck", "./buck/bin/buck2", "path to the Buck2 dotslash executable")
	flags.StringVar(&cfg.buckIsolationDir, "buck-isolation-dir", "buck2-3p-osv-tests", "Buck2 isolation directory used for metadata audits")
	flags.StringVar(&cfg.cargoLockPath, "cargo-lock", "buck/third-party/rust/Cargo.lock", "Cargo.lock to scan")
	flags.IntVar(&cfg.batchSize, "batch-size", 100, "queries per OSV batch")
	flags.IntVar(&cfg.concurrency, "concurrency", 8, "maximum concurrent OSV requests")
	flags.DurationVar(&cfg.httpTimeout, "http-timeout", 60*time.Second, "timeout for each OSV request")
	flags.Usage = func() {
		fmt.Fprintln(stderr, "Usage: 3p-osv [flags] [all|generic|rust] [Cargo.lock]")
		fmt.Fprintln(stderr, "Checks all dependency sets when no mode is supplied.")
		flags.PrintDefaults()
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	remaining := flags.Args()
	mode := "all"
	if len(remaining) > 0 {
		mode = remaining[0]
		remaining = remaining[1:]
	}
	if mode != "all" && mode != "generic" && mode != "rust" {
		fmt.Fprintf(stderr, "ERROR: unknown check mode %q\n", mode)
		flags.Usage()
		return 2
	}
	if mode == "rust" && len(remaining) == 1 {
		cfg.cargoLockPath = remaining[0]
		remaining = nil
	}
	if len(remaining) != 0 {
		fmt.Fprintln(stderr, "ERROR: too many positional arguments")
		flags.Usage()
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

	violation, err := execute(ctx, cfg, mode, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "ERROR: %v\n", err)
		return 2
	}
	if violation {
		return 1
	}
	return 0
}

func execute(ctx context.Context, cfg config, mode string, output io.Writer) (bool, error) {
	var subjects []subject
	if mode == "all" || mode == "generic" {
		generic, err := collectGenericSubjects(ctx, buckAuditor{
			path:         cfg.buckPath,
			isolationDir: cfg.buckIsolationDir,
		})
		if err != nil {
			return false, err
		}
		fmt.Fprintf(output, "Loaded and validated OSV metadata for %d generic third-party packages.\n", len(generic))
		subjects = append(subjects, generic...)
	}
	if mode == "all" || mode == "rust" {
		file, err := os.Open(cfg.cargoLockPath)
		if err != nil {
			return false, fmt.Errorf("open %s: %w", cfg.cargoLockPath, err)
		}
		packages, parseErr := parseCargoLock(file)
		closeErr := file.Close()
		if parseErr != nil {
			return false, fmt.Errorf("parse %s: %w", cfg.cargoLockPath, parseErr)
		}
		if closeErr != nil {
			return false, fmt.Errorf("close %s: %w", cfg.cargoLockPath, closeErr)
		}
		rust, skipped, err := cargoSubjects(packages)
		if err != nil {
			return false, err
		}
		fmt.Fprintf(output, "Loaded %d third-party Rust crates from %s (%d source-less workspace packages skipped).\n", len(rust), cfg.cargoLockPath, skipped)
		subjects = append(subjects, rust...)
	}

	client, err := newOSVClient(cfg.apiBase, cfg.httpTimeout)
	if err != nil {
		return false, err
	}
	batchCount := (len(subjects) + cfg.batchSize - 1) / cfg.batchSize
	fmt.Fprintf(output, "Querying OSV for %d packages in %d batches...\n", len(subjects), batchCount)
	queryResults, err := client.query(ctx, subjects, cfg.batchSize, cfg.concurrency)
	if err != nil {
		return false, err
	}
	advisoryReferences := 0
	for _, result := range queryResults {
		advisoryReferences += len(result)
	}
	if advisoryReferences > 0 {
		fmt.Fprintf(output, "Fetching details for %d advisory references...\n", advisoryReferences)
	}
	details, err := client.fetchVulnerabilities(ctx, queryResults, cfg.concurrency)
	if err != nil {
		return false, err
	}
	findings, err := analyzeFindings(subjects, queryResults, details)
	if err != nil {
		return false, err
	}
	return writeReport(output, subjects, findings), nil
}

func validateExceptions() error {
	seen := make(map[string]struct{}, len(rustExceptions))
	var problems []string
	for _, item := range rustExceptions {
		if item.ID == "" || item.Reason == "" {
			problems = append(problems, "exception has an empty id or reason")
			continue
		}
		if _, duplicate := seen[item.ID]; duplicate {
			problems = append(problems, "duplicate exception "+item.ID)
		}
		seen[item.ID] = struct{}{}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("invalid Rust exceptions: %s", strings.Join(problems, "; "))
	}
	return nil
}
