// Package statuscmd implements `kvarm status <owner/repo>`: one read-only
// view of a repository's live coordination state, composed from registry
// reads only (list_workspaces, list_dependencies per active workspace,
// get_train, list_tasks). It sends no write and triggers no queue send, so
// repeated runs are idempotent.
package statuscmd

import (
	"context"
	"sync"

	"kvarm/cli/internal/errs"
	"kvarm/cli/internal/help"
	"kvarm/cli/internal/opcli"
	"kvarm/cli/internal/registry"
)

// Limits of the composite read: active workspaces listed, workspaces whose
// pins are read (one bounded read each), and reads in flight.
const (
	WorkspaceLimit  = 100
	DependencyReads = 20
	InFlight        = 4
	TrainTaskLimit  = 100
)

// Run prints the composite status and returns the exit code.
func Run(ctx context.Context, argv []string, io opcli.IO) (int, error) {
	jsonOut := false
	var positionals []string
	for _, a := range argv {
		if a == "--help" || a == "-h" {
			io.Stdout.Line(help.Status(io.Stdout, help.StatusLimits{DependencyReads: DependencyReads}))
			return 0, nil
		}
		if a == "--json" {
			jsonOut = true
			continue
		}
		if len(a) > 0 && a[0] == '-' {
			return 2, errs.NewUsage("unknown option %q for kvarm status", a)
		}
		positionals = append(positionals, a)
	}
	if len(positionals) != 1 {
		return 2, errs.NewUsage("expected <owner/repo>")
	}
	repoArg := positionals[0]

	reg := registry.Load()
	op := func(name string) *registry.Operation {
		return reg.FindOperation(name)
	}

	// read runs one registry operation, settling every read before the
	// command reports so no request is still in flight at exit.
	var mu sync.Mutex
	var failed *readFailure
	read := func(name string, args map[string]any) (map[string]any, *readFailure) {
		operation := op(name)
		reply, err := opcli.CallOperation(ctx, operation, args, io)
		if err != nil {
			return nil, &readFailure{err: err}
		}
		if !reply.OK {
			return nil, &readFailure{operation: operation, args: args, reply: reply}
		}
		obj, ok := reply.Data.(map[string]any)
		if !ok {
			return nil, &readFailure{operation: operation, args: args, reply: reply}
		}
		return obj, nil
	}
	failFast := func(f *readFailure) *readFailure {
		mu.Lock()
		defer mu.Unlock()
		if failed == nil {
			failed = f
		}
		return f
	}

	var workspaces, train, tasks map[string]any
	var wg sync.WaitGroup
	wg.Add(3)
	// The limits are cast to int64: BuildRequest validates integer
	// arguments as int64, and an untyped constant in an any would box as
	// int and be refused as a usage error.
	go func() {
		defer wg.Done()
		obj, f := read("list_workspaces", map[string]any{"repo": repoArg, "status": "active", "limit": int64(WorkspaceLimit)})
		if f == nil {
			workspaces = obj
		} else {
			failFast(f)
		}
	}()
	go func() {
		defer wg.Done()
		obj, f := read("get_train", map[string]any{"repo": repoArg, "limit": int64(TrainTaskLimit)})
		if f == nil {
			train = obj
		} else {
			failFast(f)
		}
	}()
	go func() {
		defer wg.Done()
		obj, f := read("list_tasks", map[string]any{"repo": repoArg, "status": "open", "limit": int64(TrainTaskLimit)})
		if f == nil {
			tasks = obj
		} else {
			failFast(f)
		}
	}()
	wg.Wait()
	if failed != nil {
		if failed.err != nil {
			return 1, failed.err
		}
		return opcli.ReportFailure(failed.operation, failed.args, failed.reply, jsonOut, io, "kvarm status"), nil
	}

	list, _ := workspaces["workspaces"].([]any)
	pinnedCount := len(list)
	if pinnedCount > DependencyReads {
		pinnedCount = DependencyReads
	}
	pinned := list[:pinnedCount]

	// Pin reads: at most InFlight at a time, one per active workspace.
	pins := make([]map[string]any, pinnedCount)
	sem := make(chan struct{}, InFlight)
	var pinWG sync.WaitGroup
	for i, raw := range pinned {
		i, raw := i, raw
		ws, _ := raw.(map[string]any)
		id, _ := ws["id"].(string)
		pinWG.Add(1)
		go func() {
			defer pinWG.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			obj, f := read("list_dependencies", map[string]any{"repo": repoArg, "workspace": id})
			if f != nil {
				failFast(f)
				return
			}
			pins[i] = obj
		}()
	}
	pinWG.Wait()
	if failed != nil {
		if failed.err != nil {
			return 1, failed.err
		}
		return opcli.ReportFailure(failed.operation, failed.args, failed.reply, jsonOut, io, "kvarm status"), nil
	}

	out := make([]any, 0, len(list))
	for i, raw := range list {
		ws, _ := raw.(map[string]any)
		if ws == nil {
			ws = map[string]any{}
		}
		merged := map[string]any{}
		for k, v := range ws {
			merged[k] = v
		}
		if i < pinnedCount {
			deps := []any{}
			if pins[i] != nil {
				if d, ok := pins[i]["dependencies"].([]any); ok {
					deps = d
				}
			}
			merged["dependencies"] = deps
		}
		out = append(out, merged)
	}
	status := map[string]any{
		"repo":                repoArg,
		"workspaces":          out,
		"workspacesTruncated": workspaces["nextCursor"] != nil && workspaces["nextCursor"] != "" || len(list) > pinnedCount,
		"train":               train,
		"tasks":               tasks,
	}
	opcli.PrintJSON(status, jsonOut, io.Stdout)
	return 0, nil
}

// readFailure is a failed read, carried to the single failure report.
type readFailure struct {
	operation *registry.Operation
	args      map[string]any
	reply     *opcli.Reply
	err       error
}
