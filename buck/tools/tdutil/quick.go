// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
)

// collectQuickSnapshot collects one endpoint's graph in a single workspace.
// It backs --quick analysis, where the caller compares the working-copy
// snapshot against itself, and --snapshot-to capture, where the result is
// serialized for later reuse as a base endpoint. Quick mode's documented gaps
// follow from the missing base graph: dependents of targets that no longer
// exist and hash-level definition differences cannot be seen in a lone
// snapshot.
func collectQuickSnapshot(
	ctx context.Context,
	runner processRunner,
	workspace, buck string,
	buckArgs []string,
	isolation string,
	patterns []string,
	config tdutilConfig,
) (snapshot, error) {
	if len(patterns) == 0 {
		return snapshot{}, fmt.Errorf("at least one Buck target pattern is required")
	}
	cells, err := auditCells(ctx, runner, workspace, buck, buckArgs, isolation)
	if err != nil {
		return snapshot{}, err
	}
	// The policy is left at fail: base and head are the same graph here, so
	// the predecessor cannot have regressed relative to itself.
	plan, err := planUniverse(workspace, cells, workspace, cells, patterns)
	if err != nil {
		return snapshot{}, err
	}
	collected, err := collectTargets(ctx, runner, workspace, buck, buckArgs, isolation, plan.headPatterns, cells, config)
	if err != nil {
		return snapshot{}, err
	}
	if err := validateUniverse(&plan, &collected, &collected); err != nil {
		return snapshot{}, err
	}
	return collected, nil
}
