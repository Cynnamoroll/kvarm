-- Hosted CI (issue #13's larger sibling in the CI roadmap): a repository may
-- opt in to letting the platform's own Container CI runner drain its queued
-- jobs (containers/ciRunnerSandbox.ts). The flag is per repository and only
-- ever set by a repo admin (services/hostedCi.ts); the user-owned
-- `kvarm runner` keeps racing on the same queue either way.
ALTER TABLE repos ADD COLUMN hosted_ci INTEGER NOT NULL DEFAULT 0;
