// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"strconv"
)

// objectFormat is a repository's hash function: sha1, or sha256 for
// repositories created with --object-format=sha256.
type objectFormat struct {
	name    string
	size    int
	newHash func() hash.Hash
}

var objectFormats = map[string]*objectFormat{
	"sha1":   {"sha1", sha1.Size, sha1.New},
	"sha256": {"sha256", sha256.Size, sha256.New},
}

// oid is an object id. A sha1 id uses only its first 20 bytes, and the
// rest stay zero, so ids of either format compare and hash as map keys.
type oid [sha256.Size]byte

func (f *objectFormat) parseHex(s string) (oid, bool) {
	var id oid
	if len(s) != 2*f.size {
		return id, false
	}
	_, err := hex.Decode(id[:f.size], []byte(s))
	return id, err == nil
}

func (f *objectFormat) hex(id oid) string {
	return hex.EncodeToString(id[:f.size])
}

func (f *objectFormat) idFrom(b []byte) oid {
	var id oid
	copy(id[:f.size], b)
	return id
}

func (f *objectFormat) sum(h hash.Hash) oid {
	var id oid
	h.Sum(id[:0])
	return id
}

type objectType uint8

const (
	typeCommit   objectType = 1
	typeTree     objectType = 2
	typeBlob     objectType = 3
	typeTag      objectType = 4
	typeOfsDelta objectType = 6
	typeRefDelta objectType = 7
)

func (t objectType) String() string {
	switch t {
	case typeCommit:
		return "commit"
	case typeTree:
		return "tree"
	case typeBlob:
		return "blob"
	case typeTag:
		return "tag"
	case typeOfsDelta:
		return "ofs-delta"
	case typeRefDelta:
		return "ref-delta"
	}
	return "type " + strconv.Itoa(int(t))
}

func objectTypeNamed(name string) (objectType, bool) {
	for _, t := range []objectType{typeCommit, typeTree, typeBlob, typeTag} {
		if t.String() == name {
			return t, true
		}
	}
	return 0, false
}

// writeObjectHeader writes what git hashes ahead of an object's contents.
func writeObjectHeader(w io.Writer, t objectType, size int) {
	var buf [32]byte
	b := append(buf[:0], t.String()...)
	b = append(b, ' ')
	b = strconv.AppendInt(b, int64(size), 10)
	b = append(b, 0)
	w.Write(b)
}

func (f *objectFormat) hashObject(t objectType, data []byte) oid {
	h := f.newHash()
	writeObjectHeader(h, t, len(data))
	h.Write(data)
	return f.sum(h)
}

// commitTree returns the tree a commit records. git requires it on the
// commit's first line.
func (f *objectFormat) commitTree(data []byte) (oid, error) {
	line, _, _ := bytes.Cut(data, []byte("\n"))
	if hexID, ok := bytes.CutPrefix(line, []byte("tree ")); ok {
		if id, ok := f.parseHex(string(hexID)); ok {
			return id, nil
		}
	}
	return oid{}, errors.New("malformed commit: its first line does not name a tree")
}

// tagTarget returns the object an annotated tag points at, which git
// requires on the tag's first two lines.
func (f *objectFormat) tagTarget(data []byte) (oid, objectType, error) {
	objectLine, rest, _ := bytes.Cut(data, []byte("\n"))
	typeLine, _, _ := bytes.Cut(rest, []byte("\n"))
	hexID, ok1 := bytes.CutPrefix(objectLine, []byte("object "))
	typeName, ok2 := bytes.CutPrefix(typeLine, []byte("type "))
	id, ok3 := f.parseHex(string(hexID))
	t, ok4 := objectTypeNamed(string(typeName))
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return oid{}, 0, errors.New("malformed tag: it does not start with object and type lines")
	}
	return id, t, nil
}

// File modes, as git records them in trees and in the index.
const (
	modeDir     = 0o040000
	modeFile    = 0o100644
	modeExec    = 0o100755
	modeSymlink = 0o120000
	modeGitlink = 0o160000
)

type treeEntry struct {
	mode uint32
	name string
	id   oid
}

func (f *objectFormat) parseTree(data []byte) ([]treeEntry, error) {
	var entries []treeEntry
	for len(data) > 0 {
		sp := bytes.IndexByte(data, ' ')
		if sp <= 0 {
			return nil, errors.New("malformed tree: an entry has no mode")
		}
		mode, err := strconv.ParseUint(string(data[:sp]), 8, 32)
		if err != nil {
			return nil, fmt.Errorf("malformed tree: bad mode %q", data[:sp])
		}
		data = data[sp+1:]
		nul := bytes.IndexByte(data, 0)
		if nul < 0 || len(data)-nul-1 < f.size {
			return nil, errors.New("malformed tree: truncated entry")
		}
		entries = append(entries, treeEntry{
			mode: uint32(mode),
			name: string(data[:nul]),
			id:   f.idFrom(data[nul+1:]),
		})
		data = data[nul+1+f.size:]
	}
	return entries, nil
}

// canonMode maps a tree entry's mode to the one git checks out, the way
// git's canon_mode does: any regular file with its owner-execute bit is
// executable, and other regular files are not. git treats every other
// unknown mode as a submodule; this refuses them instead.
func canonMode(mode uint32) (uint32, bool) {
	switch mode & 0o170000 {
	case 0o100000:
		if mode&0o100 != 0 {
			return modeExec, true
		}
		return modeFile, true
	case modeDir, modeSymlink, modeGitlink:
		return mode & 0o170000, true
	}
	return 0, false
}
