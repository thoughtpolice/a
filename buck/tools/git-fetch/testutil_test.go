// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
)

var (
	sha1Format   = objectFormats["sha1"]
	sha256Format = objectFormats["sha256"]
)

// packBuilder writes packs, with or without deltas, for tests.
type packBuilder struct {
	format  *objectFormat
	body    bytes.Buffer // the entries, which follow a 12-byte header
	count   int
	offsets map[oid]int
	objects map[oid]storedObject
}

type storedObject struct {
	typ  objectType
	data []byte
}

func newPackBuilder(format *objectFormat) *packBuilder {
	return &packBuilder{format: format, offsets: map[oid]int{}, objects: map[oid]storedObject{}}
}

func (b *packBuilder) offset() int { return packHeaderSize + b.body.Len() }

func (b *packBuilder) header(typ objectType, size int) {
	c := byte(typ)<<4 | byte(size&15)
	for size >>= 4; size > 0; size >>= 7 {
		b.body.WriteByte(c | 0x80)
		c = byte(size & 0x7f)
	}
	b.body.WriteByte(c)
}

func (b *packBuilder) deflate(data []byte) {
	w := zlib.NewWriter(&b.body)
	w.Write(data)
	w.Close()
}

func (b *packBuilder) record(typ objectType, data []byte, offset int) oid {
	id := b.format.hashObject(typ, data)
	b.offsets[id] = offset
	b.objects[id] = storedObject{typ, data}
	b.count++
	return id
}

// add stores a whole object.
func (b *packBuilder) add(typ objectType, data []byte) oid {
	offset := b.offset()
	b.header(typ, len(data))
	b.deflate(data)
	return b.record(typ, data, offset)
}

// addOfsDelta stores data as a delta against base, found by offset.
func (b *packBuilder) addOfsDelta(base oid, data []byte) oid {
	offset := b.offset()
	delta := makeDelta(b.objects[base].data, data)
	b.header(typeOfsDelta, len(delta))
	rel := offset - b.offsets[base]
	enc := []byte{byte(rel & 0x7f)}
	for rel >>= 7; rel > 0; rel >>= 7 {
		rel--
		enc = append([]byte{byte(0x80 | rel&0x7f)}, enc...)
	}
	b.body.Write(enc)
	b.deflate(delta)
	return b.record(b.objects[base].typ, data, offset)
}

// addRefDelta stores data as a delta against base, found by id.
func (b *packBuilder) addRefDelta(base oid, data []byte) oid {
	offset := b.offset()
	delta := makeDelta(b.objects[base].data, data)
	b.header(typeRefDelta, len(delta))
	b.body.Write(base[:b.format.size])
	b.deflate(delta)
	return b.record(b.objects[base].typ, data, offset)
}

func (b *packBuilder) bytes() []byte {
	var out bytes.Buffer
	out.WriteString("PACK")
	out.Write(binary.BigEndian.AppendUint32(nil, 2))
	out.Write(binary.BigEndian.AppendUint32(nil, uint32(b.count)))
	out.Write(b.body.Bytes())
	h := b.format.newHash()
	h.Write(out.Bytes())
	out.Write(h.Sum(nil))
	return out.Bytes()
}

// makeDelta encodes target as a copy of base's longest common prefix, an
// insert of the middle, and a copy of the longest common suffix.
func makeDelta(base, target []byte) []byte {
	d := appendDeltaSize(nil, len(base))
	d = appendDeltaSize(d, len(target))
	prefix := 0
	for prefix < len(base) && prefix < len(target) && base[prefix] == target[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(base)-prefix && suffix < len(target)-prefix &&
		base[len(base)-1-suffix] == target[len(target)-1-suffix] {
		suffix++
	}
	d = appendCopy(d, 0, prefix)
	for middle := target[prefix : len(target)-suffix]; len(middle) > 0; {
		n := min(len(middle), 127)
		d = append(d, byte(n))
		d = append(d, middle[:n]...)
		middle = middle[n:]
	}
	return appendCopy(d, len(base)-suffix, suffix)
}

func appendDeltaSize(d []byte, n int) []byte {
	for ; n >= 0x80; n >>= 7 {
		d = append(d, byte(n&0x7f|0x80))
	}
	return append(d, byte(n))
}

// appendCopy copies in pieces of at most 64 KiB, the largest of which is
// encoded with no size bytes at all.
func appendCopy(d []byte, offset, n int) []byte {
	for n > 0 {
		size := min(n, 0x10000)
		op := byte(0x80)
		var args []byte
		for i := range 4 {
			if c := byte(offset >> (8 * i)); c != 0 {
				op |= 1 << i
				args = append(args, c)
			}
		}
		if size != 0x10000 {
			for i := range 3 {
				if c := byte(size >> (8 * i)); c != 0 {
					op |= 0x10 << i
					args = append(args, c)
				}
			}
		}
		d = append(append(d, op), args...)
		offset += size
		n -= size
	}
	return d
}

// testFile is a tree entry for addTree: a file's contents, a symlink's
// target, or a submodule's commit id in hex. An empty modeDir entry is an
// empty tree.
type testFile struct {
	mode uint32
	data string
}

// addTree stores files, keyed by slash-separated path, as nested trees
// and returns the top tree's id.
func (b *packBuilder) addTree(files map[string]testFile) oid {
	children := map[string]map[string]testFile{}
	var entries []treeEntry
	for path, f := range files {
		name, rest, nested := strings.Cut(path, "/")
		if nested {
			if children[name] == nil {
				children[name] = map[string]testFile{}
			}
			children[name][rest] = f
			continue
		}
		var id oid
		switch f.mode {
		case modeDir:
			id = b.addTree(nil)
		case modeGitlink:
			id, _ = b.format.parseHex(f.data)
		default:
			id = b.add(typeBlob, []byte(f.data))
		}
		entries = append(entries, treeEntry{f.mode, name, id})
	}
	for name, sub := range children {
		entries = append(entries, treeEntry{modeDir, name, b.addTree(sub)})
	}
	return b.add(typeTree, b.format.encodeTree(entries))
}

// encodeTree writes entries in git's tree order, which sorts a directory
// as if its name ended with a slash.
func (f *objectFormat) encodeTree(entries []treeEntry) []byte {
	key := func(e treeEntry) string {
		if e.mode == modeDir {
			return e.name + "/"
		}
		return e.name
	}
	slices.SortFunc(entries, func(a, b treeEntry) int { return strings.Compare(key(a), key(b)) })
	var out bytes.Buffer
	for _, e := range entries {
		fmt.Fprintf(&out, "%o %s\x00", e.mode, e.name)
		out.Write(e.id[:f.size])
	}
	return out.Bytes()
}

func (b *packBuilder) addCommit(tree oid, parents ...oid) oid {
	var c strings.Builder
	fmt.Fprintf(&c, "tree %s\n", b.format.hex(tree))
	for _, p := range parents {
		fmt.Fprintf(&c, "parent %s\n", b.format.hex(p))
	}
	c.WriteString("author A U Thor <author@example.com> 1700000000 +0000\n")
	c.WriteString("committer A U Thor <author@example.com> 1700000000 +0000\n\ntest\n")
	return b.add(typeCommit, []byte(c.String()))
}

func (b *packBuilder) addTag(target oid, typ objectType) oid {
	data := fmt.Sprintf("object %s\ntype %s\ntag v1\ntagger A U Thor <author@example.com> 1700000000 +0000\n\nv1\n",
		b.format.hex(target), typ)
	return b.add(typeTag, []byte(data))
}

// repoPack is a pack holding one commit of files, ready to check out.
func repoPack(format *objectFormat, files map[string]testFile) ([]byte, oid) {
	b := newPackBuilder(format)
	commit := b.addCommit(b.addTree(files))
	return b.bytes(), commit
}
