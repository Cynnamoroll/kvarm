package ui

import (
	"fmt"
	"sync"
	"time"
)

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// Progress is a single animated stderr line for a running download: a
// spinner plus a byte counter. Only a terminal output animates — a pipe
// (CI logs, tests, scripts) gets nothing until the final line, so captured
// output stays line-stable.
type Progress struct {
	out     *Output
	label   string
	mu      sync.Mutex
	done    bool
	n       int64
	total   string
	stop    chan struct{}
	stopped sync.WaitGroup
}

// NewProgress starts the line "label …" (the label may contain a total, e.g.
// "downloading snapshot (12.4 MB tar)"). No-op on a non-terminal output.
func NewProgress(out *Output, label string) *Progress {
	p := &Progress{out: out, label: label, stop: make(chan struct{})}
	if !out.Color() {
		return p
	}
	p.stopped.Add(1)
	go p.run()
	return p
}

func (p *Progress) run() {
	defer p.stopped.Done()
	frame := 0
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-tick.C:
			p.mu.Lock()
			line := fmt.Sprintf("  %s %s %s", spinnerFrames[frame%len(spinnerFrames)], p.label, p.out.Dim(humanBytes(p.n)))
			p.mu.Unlock()
			frame++
			// The animation writes its own control codes, so it redacts the
			// text itself rather than going through Line.
			fmt.Fprintf(p.out.w, "\r\x1b[2K%s", p.out.redact(line))
		}
	}
}

// Set reports bytes transferred so far.
func (p *Progress) Set(n int64) {
	p.mu.Lock()
	p.n = n
	p.mu.Unlock()
}

// Finish stops the animation, clears the line and prints one final line.
func (p *Progress) Finish(summary string) {
	p.mu.Lock()
	if p.done {
		p.mu.Unlock()
		return
	}
	p.done = true
	p.mu.Unlock()
	close(p.stop)
	p.stopped.Wait()
	if p.out.Color() {
		fmt.Fprint(p.out.w, "\r\x1b[2K")
	}
	if summary != "" {
		p.out.Line(summary)
	}
}

// Cancel stops the animation and clears the line without a summary (the
// caller reports the failure itself).
func (p *Progress) Cancel() { p.Finish("") }

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}
