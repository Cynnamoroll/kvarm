-- Kvarm rename (breaking brand cutover). Additive-only: no table or column is
-- dropped, renamed or recreated, and no row is deleted. Only the brand-bound
-- string values inside existing rows are rewritten in place.
--
-- 1) Platform-owned check-run names move from the retired `forge/` prefix to
--    `kvarm/` (services/checks.ts GUARD_CHECK / CHECKS_WINDOW_CHECK;
--    services/ci.ts 'kvarm/ci-config').
UPDATE check_runs
   SET name = 'kvarm/' || substr(name, 7)
 WHERE name LIKE 'forge/%';

-- 2) CI job names are user-chosen and may not use the platform prefix; a row
--    can only carry `forge/` here if it predates the reserved-name rule.
UPDATE ci_jobs
   SET name = 'kvarm/' || substr(name, 7)
 WHERE name LIKE 'forge/%';

-- 3) branch_rules.required_checks is a JSON array (TEXT). Rewrite every element
--    that carries the retired prefix, preserving order and all other elements.
UPDATE branch_rules
   SET required_checks = (
         SELECT json_group_array(
                  CASE WHEN je.value LIKE 'forge/%'
                       THEN 'kvarm/' || substr(je.value, 7)
                       ELSE je.value END
                )
           FROM json_each(branch_rules.required_checks) AS je
       )
 WHERE EXISTS (
         SELECT 1 FROM json_each(branch_rules.required_checks) AS je
          WHERE je.value LIKE 'forge/%'
       );
