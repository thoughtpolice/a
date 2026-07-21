// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Buck2 internal-runner integration. `-list-tests` prints one test case per
// dependency set, and `-run-test` checks the case selected by the filter
// argument that the runner appends after the flags. A case gathers all of its
// vulnerability data up front — batched OSV queries held in memory, exactly
// like the plain command-line mode — and then flushes one result line per
// scanned package to the harness, so Buck2 reports a granular verdict for
// every package without a process or HTTP round-trip per package.
//
// The line protocol is shared with buck/shims/dynamic_test_internal.bzl:
//
//	listing stdout:    "test: <filter> <name>"
//	execution stdout:  "result: <PASS|FAIL|SKIP> <name> <seconds|-> [message]"
//	                   "result-details: <line>" (0+, attach to previous result)
//
// The listing is a fixed set of cases, so cached listings can never go stale:
// package discovery (Cargo.lock parsing and `buck audit package-values`)
// happens inside case execution, which Buck2 always runs fresh.
package main

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode"
)

const (
	testLinePrefix    = "test: "
	resultLinePrefix  = "result: "
	detailsLinePrefix = "result-details: "

	genericCaseName   = "generic-packages"
	genericCaseFilter = "generic:all"
	rustCaseName      = "rust-packages"
	rustCaseFilter    = "rust:all"
	npmCaseName       = "npm-packages"
	npmCaseFilter     = "npm:all"
	wolfiCaseName     = "wolfi-packages"
	wolfiCaseFilter   = "wolfi:all"
)

func writeTestListing(mode string, stdout io.Writer) {
	if mode == "all" || mode == "generic" {
		fmt.Fprintf(stdout, "%s%s %s\n", testLinePrefix, genericCaseFilter, genericCaseName)
	}
	if mode == "all" || mode == "rust" {
		fmt.Fprintf(stdout, "%s%s %s\n", testLinePrefix, rustCaseFilter, rustCaseName)
	}
	if mode == "all" || mode == "npm" {
		fmt.Fprintf(stdout, "%s%s %s\n", testLinePrefix, npmCaseFilter, npmCaseName)
	}
	if mode == "all" || mode == "wolfi" {
		fmt.Fprintf(stdout, "%s%s %s\n", testLinePrefix, wolfiCaseFilter, wolfiCaseName)
	}
}

func runHarnessTest(ctx context.Context, cfg config, filter string, stdout, stderr io.Writer) int {
	switch filter {
	case genericCaseFilter:
		return runHarnessCase(ctx, cfg, "generic", genericCaseName, cfg.auditor(), stdout, stderr)
	case rustCaseFilter:
		return runHarnessCase(ctx, cfg, "rust", rustCaseName, cfg.auditor(), stdout, stderr)
	case npmCaseFilter:
		return runHarnessCase(ctx, cfg, "npm", npmCaseName, cfg.auditor(), stdout, stderr)
	case wolfiCaseFilter:
		return runHarnessCase(ctx, cfg, "wolfi", wolfiCaseName, cfg.auditor(), stdout, stderr)
	}
	fmt.Fprintf(stderr, "ERROR: unknown test filter %q\n", filter)
	return 2
}

// protocolSafe reports whether a test name survives the space-separated line
// protocol unmangled.
func protocolSafe(name string) bool {
	return name != "" && strings.IndexFunc(name, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) < 0
}

func resultName(item subject) string {
	switch item.Kind {
	case rustSubject:
		return "cargo/" + item.Name
	case npmSubject:
		return "npm/" + item.Name
	case wolfiSubject:
		return "wolfi/" + item.Name
	}
	return item.Name
}

func emitResult(w io.Writer, status, name, duration, message string) {
	fmt.Fprintf(w, "%s%s %s %s", resultLinePrefix, status, name, duration)
	if message != "" {
		fmt.Fprintf(w, " %s", message)
	}
	fmt.Fprintln(w)
}

func emitDetails(w io.Writer, text string) {
	for _, line := range strings.Split(strings.Trim(text, "\n"), "\n") {
		fmt.Fprintf(w, "%s%s\n", detailsLinePrefix, line)
	}
}

func runHarnessCase(ctx context.Context, cfg config, mode, caseName string, auditor dependencyAuditor, stdout, stderr io.Writer) int {
	start := time.Now()
	subjects, err := collectSubjects(ctx, cfg, mode, auditor, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "ERROR: %v\n", err)
		return 2
	}
	for _, item := range subjects {
		if !protocolSafe(resultName(item)) {
			fmt.Fprintf(stderr, "ERROR: package %q cannot be reported as a test name\n", item.Name)
			return 2
		}
	}

	findings, err := queryFindings(ctx, cfg, subjects, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "ERROR: %v\n", err)
		return 2
	}

	// The full human-readable report first, exactly as in command-line mode,
	// then the per-package results the harness consumes.
	rendered := make(map[string]renderedFinding, len(findings))
	for _, item := range findings {
		block := renderFinding(item)
		fmt.Fprint(stdout, block.text)
		rendered[item.Subject.Name] = block
	}
	summary, violation := renderSummary(subjects, findings)
	fmt.Fprint(stdout, summary)

	for _, item := range subjects {
		name := resultName(item)
		block, affected := rendered[item.Name]
		if !affected {
			emitResult(stdout, "PASS", name, "-", "")
			continue
		}
		if block.blocking > 0 {
			emitResult(stdout, "FAIL", name, "-", fmt.Sprintf("%d blocking advisory group(s): %s", block.blocking, strings.Join(block.blockingIDs, ", ")))
		} else {
			emitResult(stdout, "PASS", name, "-", fmt.Sprintf("%d excepted advisory group(s)", block.excepted))
		}
		emitDetails(stdout, block.text)
	}

	caseStatus := "PASS"
	if violation {
		caseStatus = "FAIL"
	}
	duration := fmt.Sprintf("%.3f", time.Since(start).Seconds())
	summaryLine := strings.SplitN(strings.Trim(summary, "\n"), "\n", 2)[0]
	emitResult(stdout, caseStatus, caseName, duration, summaryLine)
	emitDetails(stdout, summary)
	if violation {
		return 1
	}
	return 0
}

// collectSubjects gathers the dependency subjects for one mode, printing the
// same progress lines as the command-line report flow.
func collectSubjects(ctx context.Context, cfg config, mode string, auditor dependencyAuditor, output io.Writer) ([]subject, error) {
	var subjects []subject
	if mode == "all" || mode == "generic" {
		generic, err := collectGenericSubjects(ctx, auditor)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(output, "Loaded and validated OSV metadata for %d generic third-party packages.\n", len(generic))
		subjects = append(subjects, generic...)
	}
	if mode == "all" || mode == "rust" {
		packages, err := loadCargoLock(cfg.cargoLockPath)
		if err != nil {
			return nil, err
		}
		rust, skipped, err := cargoSubjects(packages)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(output, "Loaded %d third-party Rust crates from %s (%d source-less workspace packages skipped).\n", len(rust), cfg.cargoLockPath, skipped)
		subjects = append(subjects, rust...)
	}
	if mode == "all" || mode == "npm" {
		packages, skips, err := loadPackageLock(cfg.npmLockPath)
		if err != nil {
			return nil, err
		}
		npm, err := npmSubjects(packages)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(output, "Loaded %d npm registry packages from %s (%d local, %d non-registry, %d duplicate entries skipped).\n",
			len(npm), cfg.npmLockPath, skips.Local, skips.NonRegistry, skips.Duplicate)
		subjects = append(subjects, npm...)
	}
	if mode == "all" || mode == "wolfi" {
		wolfi, err := collectWolfiSubjects(ctx, auditor)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(output, "Loaded and validated %d pinned Wolfi packages from %s.\n", len(wolfi), wolfiTargetSet)
		subjects = append(subjects, wolfi...)
	}
	return subjects, nil
}

// queryFindings runs the batched OSV queries for all subjects and returns the
// grouped advisory findings, holding everything in memory.
func queryFindings(ctx context.Context, cfg config, subjects []subject, output io.Writer) ([]finding, error) {
	client, err := newOSVClient(cfg.apiBase, cfg.httpTimeout)
	if err != nil {
		return nil, err
	}
	batchCount := (len(subjects) + cfg.batchSize - 1) / cfg.batchSize
	fmt.Fprintf(output, "Querying OSV for %d packages in %d batches...\n", len(subjects), batchCount)
	queryResults, err := client.query(ctx, subjects, cfg.batchSize, cfg.concurrency)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	return analyzeFindings(subjects, queryResults, details)
}
