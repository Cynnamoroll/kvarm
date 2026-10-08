-- The owning organization of an org repo, recorded at creation. Repos are
-- never transferred, so authorization can probe org_members by primary key
-- without resolving the owner login through `orgs` on every request.
-- NULL for personal repos.
ALTER TABLE repos ADD COLUMN owner_org_id TEXT REFERENCES orgs(id);

-- Only org repos created since 0002 can match; personal repos stay NULL.
UPDATE repos SET owner_org_id = (SELECT id FROM orgs WHERE orgs.login = repos.owner_login)
 WHERE owner_org_id IS NULL AND owner_login IN (SELECT login FROM orgs);
