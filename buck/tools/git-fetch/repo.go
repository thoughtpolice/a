// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// writeRepository writes a bare repository holding the pack, with HEAD
// detached at the commit and the shallow boundary the server reported, so
// that git can read it or clone from it.
func writeRepository(dir string, p *pack, head oid, shallow []oid) error {
	f := p.format
	for _, sub := range []string{"objects/pack", "objects/info", "refs/heads", "refs/tags"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o777); err != nil {
			return err
		}
	}
	name := filepath.Join(dir, "objects", "pack", "pack-"+f.hex(p.checksum))
	// git writes packs and their indexes read-only.
	if err := os.WriteFile(name+".pack", p.data, 0o444); err != nil {
		return err
	}
	if err := os.WriteFile(name+".idx", p.index(), 0o444); err != nil {
		return err
	}

	config := "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n"
	if f.name != "sha1" {
		config = "[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = true\n" +
			"[extensions]\n\tobjectformat = " + f.name + "\n"
	}
	files := map[string]string{
		"HEAD":   f.hex(head) + "\n",
		"config": config,
	}
	if len(shallow) > 0 {
		lines := make([]string, len(shallow))
		for i, id := range shallow {
			lines[i] = f.hex(id) + "\n"
		}
		slices.Sort(lines)
		files["shallow"] = strings.Join(slices.Compact(lines), "")
	}
	for name, contents := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o666); err != nil {
			return err
		}
	}
	return nil
}

// peelToCommit follows annotated tags from id to the commit they name.
func peelToCommit(p *pack, id oid) (oid, error) {
	for range 32 {
		typ, data, err := p.object(id)
		if err != nil {
			return oid{}, err
		}
		switch typ {
		case typeCommit:
			return id, nil
		case typeTag:
			if id, _, err = p.format.tagTarget(data); err != nil {
				return oid{}, err
			}
		default:
			return oid{}, fmt.Errorf("%s is a %s, not a commit", p.format.hex(id), typ)
		}
	}
	return oid{}, fmt.Errorf("%s is a chain of more than 32 tags", p.format.hex(id))
}

// isEmptyDir reports whether dir is missing or empty.
func isEmptyDir(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return true, nil
	}
	return len(entries) == 0, err
}
