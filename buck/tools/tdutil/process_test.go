// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

const processCancellationHelperEnvironment = "TDUTIL_PROCESS_CANCELLATION_HELPER"

func TestProcessRunnerCancellation(t *testing.T) {
	if os.Getenv(processCancellationHelperEnvironment) == "1" {
		for {
			time.Sleep(time.Hour)
		}
	}
	t.Setenv(processCancellationHelperEnvironment, "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = (osProcessRunner{}).run(ctx, commandSpec{
		path: executable,
		args: []string{"-test.run=^TestProcessRunnerCancellation$"},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want context deadline exceeded", err)
	}
}
