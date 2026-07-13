// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"runtime"
)

const (
	globWildcardError          = "wildcards are either regular `*` or recursive `**`"
	globRecursiveWildcardError = "recursive wildcards must form a single path component"
	globRangeError             = "invalid range pattern"
)

type globTokenKind int

const (
	globLiteral globTokenKind = iota
	globAnyChar
	globAnySequence
	globAnyRecursiveSequence
	globAnyWithin
	globAnyExcept
)

type globToken struct {
	kind       globTokenKind
	literal    rune
	specifiers []charSpecifier
}

type charSpecifier struct {
	start      rune
	end        rune
	rangeValue bool
}

type globPattern struct {
	original string
	tokens   []globToken
}

type globSyntaxError struct {
	position int
	message  string
}

func (e globSyntaxError) Error() string {
	return fmt.Sprintf("Pattern syntax error near position %d: %s", e.position, e.message)
}

// compileGlob implements the token grammar from Rust glob 0.3.3. In
// particular, recursive ** wildcards must occupy a complete path component.
func compileGlob(pattern string) (*globPattern, error) {
	characters := []rune(pattern)
	tokens := make([]globToken, 0, len(characters))
	for index := 0; index < len(characters); {
		switch characters[index] {
		case '?':
			tokens = append(tokens, globToken{kind: globAnyChar})
			index++
		case '*':
			start := index
			for index < len(characters) && characters[index] == '*' {
				index++
			}
			count := index - start
			switch {
			case count > 2:
				return nil, globSyntaxError{position: start + 2, message: globWildcardError}
			case count == 2:
				if !(index == 2 || isGlobSeparator(characters[index-count-1])) {
					return nil, globSyntaxError{position: start - 1, message: globRecursiveWildcardError}
				}
				if index < len(characters) && isGlobSeparator(characters[index]) {
					index++
				} else if index != len(characters) {
					return nil, globSyntaxError{position: index, message: globRecursiveWildcardError}
				}
				if !(len(tokens) > 1 && tokens[len(tokens)-1].kind == globAnyRecursiveSequence) {
					tokens = append(tokens, globToken{kind: globAnyRecursiveSequence})
				}
			default:
				tokens = append(tokens, globToken{kind: globAnySequence})
			}
		case '[':
			if index+4 <= len(characters) && characters[index+1] == '!' {
				closing := runeIndex(characters[index+3:], ']')
				if closing >= 0 {
					contents := characters[index+2 : index+3+closing]
					tokens = append(tokens, globToken{kind: globAnyExcept, specifiers: parseCharSpecifiers(contents)})
					index += closing + 4
					continue
				}
			} else if index+3 <= len(characters) && characters[index+1] != '!' {
				closing := runeIndex(characters[index+2:], ']')
				if closing >= 0 {
					contents := characters[index+1 : index+2+closing]
					tokens = append(tokens, globToken{kind: globAnyWithin, specifiers: parseCharSpecifiers(contents)})
					index += closing + 3
					continue
				}
			}
			return nil, globSyntaxError{position: index, message: globRangeError}
		default:
			tokens = append(tokens, globToken{kind: globLiteral, literal: characters[index]})
			index++
		}
	}
	return &globPattern{original: pattern, tokens: tokens}, nil
}

func runeIndex(values []rune, wanted rune) int {
	for index, value := range values {
		if value == wanted {
			return index
		}
	}
	return -1
}

func parseCharSpecifiers(contents []rune) []charSpecifier {
	result := make([]charSpecifier, 0, len(contents))
	for index := 0; index < len(contents); {
		if index+3 <= len(contents) && contents[index+1] == '-' {
			result = append(result, charSpecifier{start: contents[index], end: contents[index+2], rangeValue: true})
			index += 3
		} else {
			result = append(result, charSpecifier{start: contents[index], end: contents[index]})
			index++
		}
	}
	return result
}

type globMatchResult uint8

const (
	globMatches globMatchResult = iota
	globSubpatternDoesNotMatch
	globEntirePatternDoesNotMatch
)

type globMatchKey struct {
	token            int
	character        int
	followsSeparator bool
}

func (p *globPattern) matches(path string) bool {
	characters := []rune(path)
	memo := make(map[globMatchKey]globMatchResult)
	computed := make(map[globMatchKey]bool)
	var matchFrom func(bool, int, int) globMatchResult
	matchFrom = func(followsSeparator bool, characterIndex, tokenIndex int) globMatchResult {
		key := globMatchKey{token: tokenIndex, character: characterIndex, followsSeparator: followsSeparator}
		if computed[key] {
			return memo[key]
		}
		computed[key] = true
		result := globSubpatternDoesNotMatch
		defer func() { memo[key] = result }()

		for index := tokenIndex; index < len(p.tokens); index++ {
			token := p.tokens[index]
			switch token.kind {
			case globAnySequence, globAnyRecursiveSequence:
				empty := matchFrom(followsSeparator, characterIndex, index+1)
				if empty != globSubpatternDoesNotMatch {
					result = empty
					return result
				}
				for characterIndex < len(characters) {
					character := characters[characterIndex]
					if followsSeparator && character == '.' {
						result = globSubpatternDoesNotMatch
						return result
					}
					followsSeparator = isGlobSeparator(character)
					characterIndex++
					if token.kind == globAnyRecursiveSequence && !followsSeparator {
						continue
					}
					if token.kind == globAnySequence && followsSeparator {
						result = globSubpatternDoesNotMatch
						return result
					}
					candidate := matchFrom(followsSeparator, characterIndex, index+1)
					if candidate != globSubpatternDoesNotMatch {
						result = candidate
						return result
					}
				}
			default:
				if characterIndex >= len(characters) {
					result = globEntirePatternDoesNotMatch
					return result
				}
				character := characters[characterIndex]
				separator := isGlobSeparator(character)
				matched := false
				switch token.kind {
				case globAnyChar, globAnyWithin, globAnyExcept:
					if !separator && !(followsSeparator && character == '.') {
						switch token.kind {
						case globAnyChar:
							matched = true
						case globAnyWithin:
							matched = inCharSpecifiers(token.specifiers, character)
						case globAnyExcept:
							matched = !inCharSpecifiers(token.specifiers, character)
						}
					}
				case globLiteral:
					matched = globCharactersEqual(character, token.literal)
				}
				if !matched {
					result = globSubpatternDoesNotMatch
					return result
				}
				followsSeparator = separator
				characterIndex++
			}
		}
		if characterIndex == len(characters) {
			result = globMatches
		} else {
			result = globSubpatternDoesNotMatch
		}
		return result
	}
	return matchFrom(true, 0, 0) == globMatches
}

func isGlobSeparator(character rune) bool {
	return character == '/' || (runtime.GOOS == "windows" && character == '\\')
}

func globCharactersEqual(left, right rune) bool {
	return left == right || (runtime.GOOS == "windows" && isGlobSeparator(left) && isGlobSeparator(right))
}

func inCharSpecifiers(specifiers []charSpecifier, character rune) bool {
	for _, specifier := range specifiers {
		if specifier.rangeValue {
			if character >= specifier.start && character <= specifier.end {
				return true
			}
		} else if character == specifier.start {
			return true
		}
	}
	return false
}

type globList struct {
	declared   bool
	inclusions []*globPattern
	exclusions []*globPattern
}

func compileGlobList(patterns []string, targetLabel, attribute string) (globList, error) {
	result := globList{declared: len(patterns) != 0}
	for _, raw := range patterns {
		pattern := raw
		exclusion := false
		if len(pattern) != 0 && pattern[0] == '!' {
			pattern = pattern[1:]
			exclusion = true
		}
		compiled, err := compileGlob(pattern)
		if err != nil {
			return globList{}, fmt.Errorf("invalid `%s` glob `%s` on target `%s`: %w", attribute, raw, targetLabel, err)
		}
		if exclusion {
			result.exclusions = append(result.exclusions, compiled)
		} else {
			result.inclusions = append(result.inclusions, compiled)
		}
	}
	return result, nil
}

func (patterns globList) isUndeclared() bool { return !patterns.declared }

func (patterns globList) matches(path string) bool {
	for _, exclusion := range patterns.exclusions {
		if exclusion.matches(path) {
			return false
		}
	}
	for _, inclusion := range patterns.inclusions {
		if inclusion.matches(path) {
			return true
		}
	}
	return false
}
