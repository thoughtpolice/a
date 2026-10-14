// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// element is an XML element named by its local name, ignoring namespaces.
// text is its string value: all character data inside it, in order.
type element struct {
	name     string
	text     string
	children []*element
}

func parseXML(data []byte) (*element, error) {
	dec := xml.NewDecoder(bytes.NewReader(data))
	var root *element
	var stack []*element
	var texts []*strings.Builder
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("response body is not XML: %v", err)
		}
		switch tok := tok.(type) {
		case xml.StartElement:
			e := &element{name: tok.Name.Local}
			if len(stack) > 0 {
				parent := stack[len(stack)-1]
				parent.children = append(parent.children, e)
			} else if root == nil {
				root = e
			}
			stack = append(stack, e)
			texts = append(texts, &strings.Builder{})
		case xml.EndElement:
			stack[len(stack)-1].text = texts[len(texts)-1].String()
			stack, texts = stack[:len(stack)-1], texts[:len(texts)-1]
		case xml.CharData:
			for _, t := range texts {
				t.Write(tok)
			}
		}
	}
	if root == nil {
		return nil, errors.New("response body is not XML: no root element")
	}
	return root, nil
}

// A path selects elements by local name. Its first segment matches elements
// at any depth or, after a leading '/', only the root element; each later
// segment matches children of the previous selection. A segment may end with
// a 1-based index, as in Bucket[2]/Name, which keeps only that match of the
// segment, counted across the whole selection in document order.
type pathSegment struct {
	name  string
	index int // 0 when the segment has no index
}

type elementPath struct {
	absolute bool
	segments []pathSegment
}

func parsePath(s string) (elementPath, error) {
	p := elementPath{absolute: strings.HasPrefix(s, "/")}
	for _, seg := range strings.Split(strings.TrimPrefix(s, "/"), "/") {
		name, index := seg, 0
		if open := strings.IndexByte(seg, '['); open >= 0 {
			n, err := strconv.Atoi(strings.TrimSuffix(seg[open+1:], "]"))
			if !strings.HasSuffix(seg, "]") || err != nil || n < 1 {
				return p, fmt.Errorf("bad element path %q: an index must look like Name[1]", s)
			}
			name, index = seg[:open], n
		}
		if name == "" || strings.ContainsAny(name, "[] \t") {
			return p, fmt.Errorf("bad element path %q: want names separated by '/'", s)
		}
		p.segments = append(p.segments, pathSegment{name, index})
	}
	return p, nil
}

func (p elementPath) selectFrom(root *element) []*element {
	var matches []*element
	for i, seg := range p.segments {
		var next []*element
		switch {
		case i > 0:
			for _, e := range matches {
				for _, c := range e.children {
					if c.name == seg.name {
						next = append(next, c)
					}
				}
			}
		case p.absolute:
			if root.name == seg.name {
				next = []*element{root}
			}
		default:
			var walk func(*element)
			walk = func(e *element) {
				if e.name == seg.name {
					next = append(next, e)
				}
				for _, c := range e.children {
					walk(c)
				}
			}
			walk(root)
		}
		if seg.index > 0 {
			if seg.index > len(next) {
				return nil
			}
			next = next[seg.index-1 : seg.index]
		}
		matches = next
	}
	return matches
}
