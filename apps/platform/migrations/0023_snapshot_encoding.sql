-- Snapshot tarballs may be stored compressed (architecture §11.5).
-- `encoding` is NULL for a plain tar object, 'zstd' for an object holding
-- zstd frames; `encoded_size` is the stored object's byte size (NULL for a
-- plain tar, whose object size is already `size`). `size` stays the
-- uncompressed tar size in either case.
ALTER TABLE snapshot_trees ADD COLUMN encoding TEXT;
ALTER TABLE snapshot_trees ADD COLUMN encoded_size INTEGER;
