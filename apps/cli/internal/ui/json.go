package ui

// JSONColorize colors a serialized JSON document for a terminal: keys cyan,
// strings green, numbers magenta, true/false/null yellow. It walks the text
// with a tiny scanner rather than regexes, so escapes inside strings never
// confuse it. Only meaningful when the output has color; callers may use it
// unconditionally because a plain Output gets the text back unchanged.
func JSONColorize(o *Output, s string) string {
	if !o.Color() {
		return s
	}
	var b []byte
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == '"':
			end, isKey := scanString(s, i)
			text := s[i : end+1]
			if isKey {
				b = appendStyled(b, text, ansiCyan)
			} else {
				b = appendStyled(b, text, ansiGreen)
			}
			i = end + 1
		case c == '-' || (c >= '0' && c <= '9'):
			end := i + 1
			for end < len(s) && (s[end] == '.' || s[end] == 'e' || s[end] == 'E' || s[end] == '-' || s[end] == '+' || (s[end] >= '0' && s[end] <= '9')) {
				end++
			}
			b = appendStyled(b, s[i:end], ansiMag)
			i = end
		case hasPrefix(s, i, "true") || hasPrefix(s, i, "false") || hasPrefix(s, i, "null"):
			end := i
			for end < len(s) && s[end] != ',' && s[end] != '\n' && s[end] != ' ' && s[end] != '}' && s[end] != ']' {
				end++
			}
			b = appendStyled(b, s[i:end], ansiYellow)
			i = end
		default:
			b = append(b, c)
			i++
		}
	}
	return string(b)
}

func appendStyled(b []byte, text, code string) []byte {
	b = append(b, code...)
	b = append(b, text...)
	b = append(b, ansiReset...)
	return b
}

func hasPrefix(s string, i int, word string) bool {
	return len(s)-i >= len(word) && s[i:i+len(word)] == word
}

// scanString returns the index of the closing quote of the string at i and
// whether it is an object key (a string followed by ':' — the only way a
// key differs from a value lexically).
func scanString(s string, i int) (end int, isKey bool) {
	j := i + 1
	for j < len(s) {
		if s[j] == '\\' {
			j += 2
			continue
		}
		if s[j] == '"' {
			break
		}
		j++
	}
	end = j
	k := end + 1
	for k < len(s) && (s[k] == ' ' || s[k] == '\n' || s[k] == '\t') {
		k++
	}
	return end, k < len(s) && s[k] == ':'
}

// HumanBytes is the byte formatter shared by progress lines and summaries.
func HumanBytes(n int64) string { return humanBytes(n) }
