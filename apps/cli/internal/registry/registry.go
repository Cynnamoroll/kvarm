// Package registry loads the operation registry the Go CLI embeds: every
// entry is one REST endpoint, one MCP tool and one `kvarm <group> <verb>`
// command at the same time. The JSON is generated from packages/ops
// (scripts/gen-cli-registry.mjs), the shared source of record, and a drift
// test fails when the committed copy is stale.
package registry

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
)

//go:embed operations.json
var operationsJSON []byte

// ParamType is the wire type of a parameter.
type ParamType string

const (
	TypeString  ParamType = "string"
	TypeInteger ParamType = "integer"
	TypeBoolean ParamType = "boolean"
	TypeStrings ParamType = "string[]"
	TypeJSON    ParamType = "json"
)

// Param is one parameter of an operation: a positional argument or a
// --kebab-case flag, sent in the path, the query or the JSON body.
type Param struct {
	Name        string    `json:"name"`
	Type        ParamType `json:"type"`
	In          string    `json:"in"` // path | query | body
	Description string    `json:"description"`
	Required    bool      `json:"required,omitempty"`
	Positional  bool      `json:"positional,omitempty"`
	Enum        []string  `json:"enum,omitempty"`
	Format      string    `json:"format,omitempty"` // "repo": owner/name, two encoded path segments
	Literal     bool      `json:"literal,omitempty"`
}

// Operation is one registry entry: one CLI command, one REST route and one
// MCP tool.
type Operation struct {
	Name        string   `json:"name"` // MCP tool name
	Command     []string `json:"command"`
	Family      string   `json:"family"`
	Description string   `json:"description"`
	Method      string   `json:"method"`
	Path        string   `json:"path"`
	Params      []Param  `json:"params"`
	ReadOnly    bool     `json:"readOnly"`
	Destructive bool     `json:"destructive,omitempty"`
}

// GroupMeta is one parent command with its blurb.
type GroupMeta struct {
	Name  string `json:"name"`
	Blurb string `json:"blurb"`
}

type file struct {
	Version    int         `json:"version"`
	Groups     []GroupMeta `json:"groups"`
	Operations []Operation `json:"operations"`
}

// Registry is the loaded operation registry.
type Registry struct {
	Version    int
	Groups     []GroupMeta
	Operations []*Operation

	byCommand map[string]*Operation
	byName    map[string]*Operation
}

var loaded = load()

// Load returns the embedded registry.
func Load() *Registry { return loaded }

func load() *Registry {
	var f file
	if err := json.Unmarshal(operationsJSON, &f); err != nil {
		panic("kvarm: embedded operations.json is invalid: " + err.Error())
	}
	r := &Registry{
		Version:    f.Version,
		Groups:     f.Groups,
		Operations: make([]*Operation, len(f.Operations)),
		byCommand:  make(map[string]*Operation, len(f.Operations)),
		byName:     make(map[string]*Operation, len(f.Operations)),
	}
	for i := range f.Operations {
		op := &f.Operations[i]
		r.Operations[i] = op
		r.byCommand[strings.Join(op.Command, " ")] = op
		r.byName[op.Name] = op
	}
	return r
}

// FindCommand returns the operation for a command path, or nil.
func (r *Registry) FindCommand(words []string) *Operation {
	return r.byCommand[strings.Join(words, " ")]
}

// FindOperation returns the operation with an MCP tool name, or nil.
func (r *Registry) FindOperation(name string) *Operation { return r.byName[name] }

// GroupCommands returns the operations of one group in registry order.
func (r *Registry) GroupCommands(group string) []*Operation {
	var out []*Operation
	for _, op := range r.Operations {
		if op.Command[0] == group {
			out = append(out, op)
		}
	}
	return out
}

// GroupCommandsSorted returns the operations of one group sorted by verb,
// the order the group help lists them in.
func (r *Registry) GroupCommandsSorted(group string) []*Operation {
	out := r.GroupCommands(group)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Command[1] < out[j].Command[1] })
	return out
}

// HasGroup reports whether the group exists.
func (r *Registry) HasGroup(group string) bool { return len(r.GroupCommands(group)) > 0 }

// GroupNames returns every group name in registry (first-appearance) order.
func (r *Registry) GroupNames() []string {
	out := make([]string, 0, len(r.Groups))
	for _, g := range r.Groups {
		out = append(out, g.Name)
	}
	return out
}

// GroupBlurb returns the group's one-line blurb, or "" when it has none.
func (r *Registry) GroupBlurb(group string) string {
	for _, g := range r.Groups {
		if g.Name == group {
			return g.Blurb
		}
	}
	return ""
}
