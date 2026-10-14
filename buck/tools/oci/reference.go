// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"regexp"
	"strings"
)

// reference is a registry image reference, [DOMAIN/]REPO[:TAG][@DIGEST].
type reference struct {
	// domain is the registry as written, or docker.io for none.
	domain     string
	repository string
	tag        string
	digest     string
}

var (
	repositoryPattern = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$`)
	tagPattern        = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
)

func parseReference(s string) (reference, error) {
	var ref reference
	name := s
	if i := strings.Index(name, "@"); i >= 0 {
		ref.digest = name[i+1:]
		name = name[:i]
		if _, _, err := splitDigest(ref.digest); err != nil {
			return ref, fmt.Errorf("%s: %w", s, err)
		}
	}
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		ref.tag = name[i+1:]
		name = name[:i]
		if !tagPattern.MatchString(ref.tag) {
			return ref, fmt.Errorf("%s: invalid tag %q", s, ref.tag)
		}
	}
	first, rest, found := strings.Cut(name, "/")
	if found && (strings.ContainsAny(first, ".:") || first == "localhost") {
		ref.domain, name = first, rest
	} else {
		ref.domain = "docker.io"
	}
	if ref.domain == "docker.io" && !strings.Contains(name, "/") {
		name = "library/" + name
	}
	if !repositoryPattern.MatchString(name) {
		return ref, fmt.Errorf("%s: invalid repository name %q", s, name)
	}
	ref.repository = name
	return ref, nil
}

// apiHost is the host that serves the registry API for the domain.
func (r reference) apiHost() string {
	if r.domain == "docker.io" || r.domain == "index.docker.io" {
		return "registry-1.docker.io"
	}
	return r.domain
}

// name is the reference without its tag or digest.
func (r reference) name() string {
	return r.domain + "/" + r.repository
}

func (r reference) String() string {
	s := r.name()
	if r.tag != "" {
		s += ":" + r.tag
	}
	if r.digest != "" {
		s += "@" + r.digest
	}
	return s
}
