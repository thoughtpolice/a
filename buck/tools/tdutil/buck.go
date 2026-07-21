// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

const targetAttributes = `^buck\.|^name$|^labels$|^ci_srcs$|^ci_srcs_must_match$|^ci_deps$`

type snapshotResult struct {
	snapshot snapshot
	err      error
}

type cellMapResult struct {
	cells cellMap
	err   error
}

// collectSnapshotPair collects both endpoint graphs concurrently. Both
// workers are always joined, and a base failure wins when both endpoints fail.
func collectSnapshotPair(
	ctx context.Context,
	runner processRunner,
	baseWorkspace, headWorkspace, buck string,
	buckArgs []string,
	isolation string,
	patterns []string,
) (snapshot, snapshot, error) {
	if len(patterns) == 0 {
		return snapshot{}, snapshot{}, fmt.Errorf("at least one Buck target pattern is required")
	}

	baseCellsChannel := make(chan cellMapResult, 1)
	headCellsChannel := make(chan cellMapResult, 1)
	go func() {
		cells, err := auditCells(ctx, runner, baseWorkspace, buck, buckArgs, isolation)
		baseCellsChannel <- cellMapResult{cells: cells, err: err}
	}()
	go func() {
		cells, err := auditCells(ctx, runner, headWorkspace, buck, buckArgs, isolation)
		headCellsChannel <- cellMapResult{cells: cells, err: err}
	}()
	baseCells := <-baseCellsChannel
	headCells := <-headCellsChannel
	if baseCells.err != nil {
		return snapshot{}, snapshot{}, baseCells.err
	}
	if headCells.err != nil {
		return snapshot{}, snapshot{}, headCells.err
	}

	plan, err := planUniverse(baseWorkspace, baseCells.cells, headWorkspace, headCells.cells, patterns)
	if err != nil {
		return snapshot{}, snapshot{}, err
	}

	baseChannel := make(chan snapshotResult, 1)
	headChannel := make(chan snapshotResult, 1)
	go func() {
		collected, err := collectTargets(ctx, runner, baseWorkspace, buck, buckArgs, isolation, plan.basePatterns, baseCells.cells)
		baseChannel <- snapshotResult{snapshot: collected, err: err}
	}()
	go func() {
		collected, err := collectTargets(ctx, runner, headWorkspace, buck, buckArgs, isolation, plan.headPatterns, headCells.cells)
		headChannel <- snapshotResult{snapshot: collected, err: err}
	}()
	base := <-baseChannel
	head := <-headChannel
	if base.err != nil {
		return snapshot{}, snapshot{}, base.err
	}
	if head.err != nil {
		return snapshot{}, snapshot{}, head.err
	}
	if err := validateUniverse(&plan, &base.snapshot, &head.snapshot); err != nil {
		return snapshot{}, snapshot{}, err
	}
	return base.snapshot, head.snapshot, nil
}

func auditCells(
	ctx context.Context,
	runner processRunner,
	workspace, buck string,
	buckArgs []string,
	isolation string,
) (cellMap, error) {
	args := isolationArgs(isolation)
	args = append(args, "audit", "cell", "--json")
	args = append(args, buckArgs...)
	result, err := runner.run(ctx, commandSpec{path: buck, args: args, dir: workspace})
	if err != nil {
		return cellMap{}, fmt.Errorf("failed to run `%s audit cell --json` in `%s`: %w", buck, workspace, err)
	}
	if err := ensureBuckProcessSuccess("buck2 audit cell", result); err != nil {
		return cellMap{}, err
	}
	if !utf8.Valid(result.stdout) {
		return cellMap{}, fmt.Errorf("`buck2 audit cell` produced non-UTF-8 stdout")
	}
	return parseCellMap(workspace, result.stdout)
}

func collectTargets(
	ctx context.Context,
	runner processRunner,
	workspace, buck string,
	buckArgs []string,
	isolation string,
	patterns []string,
	cells cellMap,
) (snapshot, error) {
	if len(patterns) == 0 {
		return emptySnapshot(cells), nil
	}
	args := isolationArgs(isolation)
	args = append(args, "targets")
	args = append(args, buckArgs...)
	args = append(args,
		"--streaming",
		"--keep-going",
		"--no-cache",
		"--show-unconfigured-target-hash",
		"--json-lines",
		"--imports",
		"--output-attribute="+targetAttributes,
	)
	args = append(args, patterns...)
	parser := newTargetStreamParser(cells)
	result, err := runProcessLines(ctx, runner, commandSpec{path: buck, args: args, dir: workspace}, parser.consume)
	if err != nil {
		return snapshot{}, fmt.Errorf("failed to run `%s targets` in `%s`: %w", buck, workspace, err)
	}
	if err := ensureBuckProcessSuccess("buck2 targets", result); err != nil {
		return snapshot{}, err
	}
	return parser.finish()
}

func isolationArgs(isolation string) []string {
	if isolation == "" {
		return nil
	}
	return []string{"--isolation-dir", isolation}
}

func ensureBuckProcessSuccess(description string, result processResult) error {
	if !result.signaled && result.exitCode == 0 {
		return nil
	}
	status := "terminated by signal"
	if !result.signaled {
		status = fmt.Sprintf("exit %d", result.exitCode)
	}
	return fmt.Errorf("%s failed (%s): %s", description, status, strings.TrimSpace(string(result.stderr)))
}
