-- Bounded public-repository listing for sitemap.xml (architecture §11.6). Additive only.
--
-- The sitemap lists public repositories by pushed_at (services/agentDiscovery.ts).
-- Without an index over public rows, that read walks idx_repos_pushed and discards
-- private rows until it has its LIMIT, so rows read grow with the private table.
-- The partial index bounds the read to the public rows the sitemap lists.

CREATE INDEX idx_repos_public_pushed ON repos(pushed_at) WHERE visibility = 'public';
