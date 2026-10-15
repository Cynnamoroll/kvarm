package checkout

import (
	"io"

	"github.com/klauspost/compress/zstd"
)

// newZstdReader decodes a stored zstd object, frame by frame: the snapshot
// builder stores one frame per build step, and the decoder continues across
// frame boundaries the way `zstd -d` does. Output streams as the decoder
// produces it, so memory stays bounded by the window, never a whole frame.
func newZstdReader(r io.Reader) (io.ReadCloser, error) {
	dec, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(1))
	if err != nil {
		return nil, err
	}
	return dec.IOReadCloser(), nil
}
