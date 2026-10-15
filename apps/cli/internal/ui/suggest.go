package ui

import "strings"

// Suggest returns the closest candidates to what the user typed: the
// delight of "did you mean" without the noise of unrelated commands.
// A candidate appears when its edit distance is at most 2, or the input is
// a prefix of it (typos that drop a tail are the most common kind).
func Suggest(typed string, candidates []string) []string {
	type scored struct {
		name   string
		dist   int
		prefix bool
	}
	var scoredCandidates []scored
	for _, c := range candidates {
		d := levenshtein(typed, c)
		p := strings.HasPrefix(c, typed) && typed != ""
		if d <= 2 || p {
			scoredCandidates = append(scoredCandidates, scored{c, d, p})
		}
	}
	// Closest first, prefix matches ahead of edit-distance ties, then name.
	for i := 1; i < len(scoredCandidates); i++ {
		for j := i; j > 0; j-- {
			a, b := scoredCandidates[j-1], scoredCandidates[j]
			aScore, bScore := a.dist, b.dist
			if a.prefix {
				aScore--
			}
			if b.prefix {
				bScore--
			}
			if aScore > bScore || (aScore == bScore && a.name > b.name) {
				scoredCandidates[j-1], scoredCandidates[j] = b, a
			} else {
				break
			}
		}
	}
	out := make([]string, 0, len(scoredCandidates))
	for _, s := range scoredCandidates {
		out = append(out, s.name)
	}
	return out
}

// levenshtein is the classic edit distance, bounded by the lengths involved.
func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	if len(ra) < len(rb) {
		ra, rb = rb, ra
	}
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}
