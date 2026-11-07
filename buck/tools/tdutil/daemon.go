// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"fmt"
	"io"
	"slices"
)

// ownDaemonEnv makes buck2 start a daemon of its own for the checkout it runs
// in, rather than join a shared one. A shared daemon group serves a single
// daemon configuration and refuses a tenant whose settings or startup
// configuration differ from it; BUCK2_DAEMON_GROUP applies only while
// BUCK2_SHARE_DAEMON is on, so turning sharing off is enough.
var ownDaemonEnv = []string{"BUCK2_SHARE_DAEMON=false"}

// ownDaemonRunner runs every command with ownDaemonEnv.
type ownDaemonRunner struct {
	inner processRunner
}

func (runner ownDaemonRunner) run(ctx context.Context, spec commandSpec) (processResult, error) {
	return runner.inner.run(ctx, withOwnDaemon(spec))
}

func (runner ownDaemonRunner) runLines(ctx context.Context, spec commandSpec, line func([]byte)) (processResult, error) {
	return runProcessLines(ctx, runner.inner, withOwnDaemon(spec), line)
}

func withOwnDaemon(spec commandSpec) commandSpec {
	spec.env = append(slices.Clone(spec.env), ownDaemonEnv...)
	return spec
}

// endpointRunner is how buck2 is run in a checkout: through the inherited
// environment, or with a daemon of its own when ownDaemon says so.
func endpointRunner(runner processRunner, ownDaemon bool) processRunner {
	if ownDaemon {
		return ownDaemonRunner{inner: runner}
	}
	return runner
}

// needsOwnDaemon reports whether buck2 in a checkout of revision needs a
// daemon of its own. The daemon tdutil's buck2 calls share is the working
// copy's, so a checkout whose global configuration differs from the working
// copy's may ask it for a configuration it does not have, which a shared
// daemon group refuses outright.
func needsOwnDaemon(ctx context.Context, jj *jjClient, revision string, ignoreWorkingCopy bool, config tdutilConfig) (bool, error) {
	changed, err := jj.changedPaths(ctx, revision, "@", ignoreWorkingCopy)
	if err != nil {
		return false, err
	}
	_, global := config.globalConfigurationChange(changed)
	return global, nil
}

// stopOwnDaemon stops the daemon a checkout's buck2 started for itself, before
// the checkout is removed: nothing else would, and it would outlive tdutil. A
// failure is reported rather than returned, since the targets are still right.
func stopOwnDaemon(ctx context.Context, runner processRunner, checkout, buck string, stderr io.Writer) {
	result, err := ownDaemonRunner{inner: runner}.run(ctx, commandSpec{path: buck, args: []string{"kill"}, dir: checkout})
	if err == nil {
		err = ensureBuckProcessSuccess("buck2 kill", result)
	}
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "tdutil: warning: stopping the buck2 daemon of %s: %v\n", checkout, err)
	}
}
