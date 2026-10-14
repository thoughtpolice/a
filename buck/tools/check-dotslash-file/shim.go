// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
)

// The SHA-256 digests of the DotSlash Windows shim releases accepted as
// foo.exe beside a DotSlash file foo.
var shimHashes = []string{
	"174387691274630e4b56b7146d164afcaf3e1d96733cd0e1979e3ad829b13721",
}

// Every release of the shim so far is exactly this size.
const shimSize = 4096

func checkShim(path string, valid []string, out io.Writer) error {
	fmt.Fprintf(out, "Checking %s...\n", filepath.Base(path))
	// The size check comes first so that a large file is never read.
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() != shimSize {
		return fmt.Errorf("%s is %d bytes, not the shim's %d", path, info.Size(), shimSize)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if !slices.Contains(valid, digest) {
		return fmt.Errorf("%s has sha256 %s, which is not a known shim (%v)", path, digest, valid)
	}
	fmt.Fprintf(out, "  ✓ Size: %d bytes\n", shimSize)
	fmt.Fprintf(out, "  ✓ Hash: %s\n", digest)
	return nil
}
