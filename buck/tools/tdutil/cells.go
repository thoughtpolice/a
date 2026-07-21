// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// cellMap records the endpoint-local Buck cell aliases which live inside a
// JJ workspace. External cells remain known so that their paths can be
// distinguished from misspelled cell names.
type cellMap struct {
	cells         map[string]string
	externalCells map[string]string
	roots         []cellRoot
}

type cellRoot struct {
	root string
	cell string
}

func parseCellMap(workspace string, data []byte) (cellMap, error) {
	if !utf8.Valid(data) {
		return cellMap{}, fmt.Errorf("invalid JSON from `buck2 audit cell`: input is not UTF-8")
	}
	if err := validateJSONUnicodeEscapes(data); err != nil {
		return cellMap{}, fmt.Errorf("invalid JSON from `buck2 audit cell`: %w", err)
	}
	var audited map[string]any
	if err := json.Unmarshal(data, &audited); err != nil {
		return cellMap{}, fmt.Errorf("invalid JSON from `buck2 audit cell`: %w", err)
	}
	if audited == nil {
		return cellMap{}, fmt.Errorf("`buck2 audit cell --json` did not return an object")
	}
	if len(audited) == 0 {
		return cellMap{}, fmt.Errorf("`buck2 audit cell --json` returned no cells")
	}

	workspace, err := absoluteNormalized(workspace)
	if err != nil {
		return cellMap{}, err
	}
	result := cellMap{
		cells:         make(map[string]string, len(audited)),
		externalCells: make(map[string]string),
	}
	for cell, rawRoot := range audited {
		if cell == "" || strings.Contains(cell, "//") {
			return cellMap{}, fmt.Errorf("invalid Buck cell name `%s`", cell)
		}
		root, ok := rawRoot.(string)
		if !ok {
			return cellMap{}, fmt.Errorf("root for Buck cell `%s` is not a string", cell)
		}
		if !filepath.IsAbs(root) {
			root = joinFilesystemPathUnclean(workspace, root)
		}
		root, err = normalizeFilesystemPath(root)
		if err != nil {
			return cellMap{}, err
		}
		relative, relErr := filepath.Rel(workspace, root)
		if relErr == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
			if relative == "." {
				relative = ""
			} else {
				relative = filepath.ToSlash(relative)
			}
			result.cells[cell] = relative
		} else {
			result.externalCells[cell] = root
		}
	}

	return assembleCellMap(result.cells, result.externalCells), nil
}

// assembleCellMap builds the derived longest-root index over a validated cell
// layout. The internal roots are repository-relative, so an assembled map is
// independent of any particular checkout location; external cells participate
// only as a name set.
func assembleCellMap(cells map[string]string, externalCells map[string]string) cellMap {
	result := cellMap{cells: cells, externalCells: externalCells}
	result.roots = make([]cellRoot, 0, len(cells))
	for cell, root := range cells {
		result.roots = append(result.roots, cellRoot{root: root, cell: cell})
	}
	sort.Slice(result.roots, func(i, j int) bool {
		if len(result.roots[i].root) != len(result.roots[j].root) {
			return len(result.roots[i].root) > len(result.roots[j].root)
		}
		return result.roots[i].cell < result.roots[j].cell
	})
	return result
}

// toRepoPath resolves a cell-qualified path into a slash-separated path
// relative to the JJ repository. A nil result denotes a known external cell.
func (m cellMap) toRepoPath(cellPath string) (*string, error) {
	cell, relative, err := splitCellPath(cellPath)
	if err != nil {
		return nil, err
	}
	relative, err = normalizeRelative(relative)
	if err != nil {
		return nil, err
	}
	if root, ok := m.cells[cell]; ok {
		joined := relative
		switch {
		case root == "":
		case relative == "":
			joined = root
		default:
			joined = root + "/" + relative
		}
		return &joined, nil
	}
	if _, ok := m.externalCells[cell]; ok {
		return nil, nil
	}
	return nil, fmt.Errorf("Buck path `%s` refers to unknown cell `%s`", cellPath, cell)
}

// toCellPath converts a repository-relative path to its most-specific Buck
// cell alias. Equal-root aliases are resolved by cell name.
func (m cellMap) toCellPath(repoPath string) (string, error) {
	repoPath, err := normalizeRelative(repoPath)
	if err != nil {
		return "", err
	}
	for _, candidate := range m.roots {
		switch {
		case candidate.root == "":
			return candidate.cell + "//" + repoPath, nil
		case repoPath == candidate.root:
			return candidate.cell + "//", nil
		case strings.HasPrefix(repoPath, candidate.root+"/"):
			return candidate.cell + "//" + strings.TrimPrefix(repoPath, candidate.root+"/"), nil
		}
	}
	return "", fmt.Errorf("repository path `%s` is not contained by a Buck cell", repoPath)
}

func (m cellMap) isKnownCell(cell string) bool {
	_, internal := m.cells[cell]
	_, external := m.externalCells[cell]
	return internal || external
}

func splitCellPath(cellPath string) (string, string, error) {
	cell, relative, ok := strings.Cut(cellPath, "//")
	if !ok {
		return "", "", fmt.Errorf("Buck path `%s` has no `//` cell separator", cellPath)
	}
	if cell == "" || strings.HasPrefix(relative, "/") {
		return "", "", fmt.Errorf("invalid Buck cell path `%s`", cellPath)
	}
	return cell, relative, nil
}

func absoluteNormalized(filePath string) (string, error) {
	if !filepath.IsAbs(filePath) {
		currentDirectory, err := os.Getwd()
		if err != nil {
			return "", err
		}
		filePath = joinFilesystemPathUnclean(currentDirectory, filePath)
	}
	return normalizeFilesystemPath(filePath)
}

func joinFilesystemPathUnclean(parent, child string) string {
	if parent == "" || strings.HasSuffix(parent, string(filepath.Separator)) {
		return parent + child
	}
	return parent + string(filepath.Separator) + child
}

func normalizeFilesystemPath(filePath string) (string, error) {
	volume := filepath.VolumeName(filePath)
	rest := strings.TrimPrefix(filePath, volume)
	abs := filepath.IsAbs(filePath)
	parts := strings.FieldsFunc(rest, func(r rune) bool {
		return r == rune(filepath.Separator) || (filepath.Separator == '\\' && r == '/')
	})
	stack := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
		case "..":
			if len(stack) == 0 {
				return "", fmt.Errorf("path `%s` escapes its filesystem root", filePath)
			}
			stack = stack[:len(stack)-1]
		default:
			stack = append(stack, part)
		}
	}
	result := filepath.Join(stack...)
	if abs {
		result = string(filepath.Separator) + result
	}
	if volume != "" {
		result = volume + result
	}
	if result == "" && abs {
		result = string(filepath.Separator)
	}
	return filepath.Clean(result), nil
}

func normalizeRelative(filePath string) (string, error) {
	if !utf8.ValidString(filePath) {
		return "", fmt.Errorf("path `%s` is not UTF-8", filePath)
	}
	if filepath.IsAbs(filePath) || strings.HasPrefix(filePath, "/") {
		return "", fmt.Errorf("expected a relative path, got `%s`", filePath)
	}
	parts := strings.Split(filepath.ToSlash(filePath), "/")
	stack := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
		case "..":
			if len(stack) == 0 {
				return "", fmt.Errorf("path `%s` escapes its filesystem root", filePath)
			}
			stack = stack[:len(stack)-1]
		default:
			stack = append(stack, part)
		}
	}
	return strings.Join(stack, "/"), nil
}
