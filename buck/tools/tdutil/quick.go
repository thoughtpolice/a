// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
)

// collectQuickSnapshot collects the working-copy graph once for --quick
// analysis. Quick mode trades the base snapshot away: the caller compares this
// snapshot against itself, so only evidence visible in the head tree — changed
// inputs, build and package files, transitive imports, CI annotations, and
// configuration files — can seed impact. Dependents of targets that no longer
// exist and hash-level definition differences need the base graph; those are
// the documented gaps of this mode.
func collectQuickSnapshot(
	ctx context.Context,
	runner processRunner,
	workspace, buck string,
	buckArgs []string,
	isolation string,
	patterns []string,
) (snapshot, error) {
	if len(patterns) == 0 {
		return snapshot{}, fmt.Errorf("at least one Buck target pattern is required")
	}
	cells, err := auditCells(ctx, runner, workspace, buck, buckArgs, isolation)
	if err != nil {
		return snapshot{}, err
	}
	plan, err := planUniverse(workspace, cells, workspace, cells, patterns)
	if err != nil {
		return snapshot{}, err
	}
	collected, err := collectTargets(ctx, runner, workspace, buck, buckArgs, isolation, plan.headPatterns, cells)
	if err != nil {
		return snapshot{}, err
	}
	if err := validateUniverse(&plan, &collected, &collected); err != nil {
		return snapshot{}, err
	}
	return collected, nil
}
