// Package httpx is the CLI's HTTP client over net/http: JSON calls read
// bodies under a hard cap (a broken platform must not be able to make the
// CLI buffer an unbounded reply), downloads stream with an idle watchdog
// (the old CLI killed a socket silent for 60 s), and a redirect to another
// host drops the Authorization header the way browsers and undici do.
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"kvarm/cli/internal/errs"
)

// IdleTimeout is how long a socket may stay silent before the request is
// aborted (the JS CLI's req.setTimeout(60_000)).
const IdleTimeout = 60 * time.Second

// MaxResponseBytes caps JSON reply bodies read into memory.
const MaxResponseBytes = 8 * 1024 * 1024

// Client wraps an *http.Client with the CLI's policies.
type Client struct {
	HTTP *http.Client
}

// New builds a client that follows redirects, drops Authorization across
// hosts, and aborts connections idle past IdleTimeout.
func New() *Client {
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: IdleTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   IdleTimeout,
		ResponseHeaderTimeout: IdleTimeout,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	hc := &http.Client{Transport: tr}
	hc.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		// A redirect to another host must not leak the token to it.
		if len(via) > 0 && via[0].Header.Get("Authorization") != "" && !sameHost(via[0].URL, req.URL) {
			req.Header.Del("Authorization")
		}
		if len(via) >= 10 {
			return fmt.Errorf("stopped after 10 redirects")
		}
		return nil
	}
	return &Client{HTTP: hc}
}

func sameHost(a, b *url.URL) bool {
	return strings.EqualFold(a.Hostname(), b.Hostname()) && a.Port() == b.Port()
}

// Response is one HTTP reply: the status and headers plus either the fully
// read (capped) text or the raw streaming body.
type Response struct {
	Status int
	Header http.Header
	// Text is the whole body as read by DoText (refusing one over the cap).
	Text string
	// Body is the streaming reply of DoStream; the caller must Close it.
	Body io.ReadCloser
	// cancel aborts the request when the idle watchdog fires.
	cancel context.CancelFunc
}

// OK reports 2xx.
func (r *Response) OK() bool { return r.Status >= 200 && r.Status < 300 }

// RetryAfter returns the Retry-After header, or "".
func (r *Response) RetryAfter() string { return r.Header.Get("Retry-After") }

// JSONValue parses Text as JSON with numbers kept as literals (UseNumber),
// so 64-bit ids round-trip exactly. A non-JSON body returns the error; the
// callers treat that like the JS CLI's JSON.parse try/catch.
func (r *Response) JSONValue() (any, error) {
	var v any
	dec := json.NewDecoder(strings.NewReader(r.Text))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// Do sends a request and reads the capped reply body into Text.
// A nil body sends nothing. capBytes <= 0 means MaxResponseBytes.
func (c *Client) DoText(ctx context.Context, method, rawURL string, headers map[string]string, body []byte, capBytes int64) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, bodyReader(body))
	if err != nil {
		return nil, errs.NewFailure("invalid request URL %q: %v", rawURL, err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, errs.NewFailure("%v", unwrapURLError(err))
	}
	defer res.Body.Close()
	text, err := readCapped(res.Body, capBytes)
	if err != nil {
		return nil, err
	}
	return &Response{Status: res.StatusCode, Header: res.Header, Text: text}, nil
}

// DoStream sends a request and returns the reply body for streaming reads
// with the idle watchdog armed; the caller must Close it.
func (c *Client) DoStream(ctx context.Context, method, rawURL string, headers map[string]string) (*Response, error) {
	ctx, cancel := context.WithCancel(ctx)
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		cancel()
		return nil, errs.NewFailure("invalid request URL %q: %v", rawURL, err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		cancel()
		return nil, errs.NewFailure("%v", unwrapURLError(err))
	}
	var fired atomic.Bool
	timer := time.AfterFunc(IdleTimeout, func() {
		fired.Store(true)
		// Aborting the request context unblocks the pending Read.
		cancel()
	})
	body := &idleBody{inner: res.Body, host: req.URL.Host, fired: &fired, timer: timer, timeout: IdleTimeout}
	return &Response{Status: res.StatusCode, Header: res.Header, Body: body, cancel: cancel}, nil
}

func bodyReader(body []byte) io.Reader {
	if body == nil {
		return nil
	}
	return bytes.NewReader(body)
}

func readCapped(r io.Reader, capBytes int64) (string, error) {
	if capBytes <= 0 {
		capBytes = MaxResponseBytes
	}
	buf := &bytes.Buffer{}
	n, err := io.Copy(buf, io.LimitReader(r, capBytes+1))
	if err != nil {
		return "", errs.NewFailure("reading the response body: %v", unwrapURLError(err))
	}
	if n > capBytes {
		return "", errs.NewFailure("response body exceeds the %d-byte read cap", capBytes)
	}
	return buf.String(), nil
}

// idleBody re-arms the idle watchdog on every successful Read; a Read that
// fails after the watchdog fired reports the old CLI's wording.
type idleBody struct {
	inner   io.ReadCloser
	host    string
	fired   *atomic.Bool
	timer   *time.Timer
	timeout time.Duration
}

func (b *idleBody) Read(p []byte) (int, error) {
	b.timer.Reset(b.timeout)
	n, err := b.inner.Read(p)
	if err != nil && b.fired.Load() {
		return n, errs.NewFailure("no data from %s for %.0fs", b.host, b.timeout.Seconds())
	}
	return n, err
}

func (b *idleBody) Close() error {
	b.timer.Stop()
	return b.inner.Close()
}

// Close aborts the stream (used on checksum mismatch, before the body is drained).
func (r *Response) Close() {
	if r.cancel != nil {
		r.cancel()
	}
	if r.Body != nil {
		r.Body.Close()
	}
}

func unwrapURLError(err error) error {
	if ue, ok := err.(*url.Error); ok {
		if ue.Timeout() {
			return fmt.Errorf("no data from %s for %.0fs", ue.URL, IdleTimeout.Seconds())
		}
		if ne, ok := ue.Err.(*net.OpError); ok {
			return fmt.Errorf("%s %s: %v", ne.Op, ne.Addr, ue.Err)
		}
		return ue.Err
	}
	return err
}
