# Fleet run: 100 active workspaces and a paced change burst

Run 2026-10-11T15:55:57.607Z → 2026-10-11T16:07:34.375Z against the live worker (version 3e0d79ae-f9c0-489d-aeb5-a4ab5cf80c79), driver `scripts/fleet-driver.mjs` at `777ce61`, scratch repo `cynthia/scale-staged-campaign-fleet-1791734157` (deleted afterwards).

## Limits in force

One driver process; ≤ 3 git children and ≤ 5 in-flight HTTP requests; campaign ceiling 10000 harness requests; per-credential git write limit 120/min with pushes paced at 30/min; enqueues paced ≥ 600 ms apart; 429 Retry-After honored with bounded retries.

## Workload

| Item | Value |
|---|---|
| Active workspaces (distinct agent identities) | 100 |
| Changes in the burst | 99 |
| Crafted overlap pairs found by the Nexus overlap query | 69 |

## Measured burst results

| Metric | Value |
|---|---|
| Accepted publications | 99 |
| Incomplete cases (listed with reasons in the JSON report) | 0 |
| Burst window (first enqueue → last publication) | 361.9 s |
| Throughput (accepted publications per minute over the window) | 15.91 |
| Latency enqueue → published, server clock (p50 / p90 / max) | 94.0 s / 219.1 s / 361.9 s |
| Max queue backlog observed (active entries) | 64 |
| Longest interval with no queue entry reaching a terminal state | 79.7 s (+235.1 s → +314.7 s after the first enqueue; ended by #90 ejected MERGE_CONFLICT) |
| 429 QUEUE_FULL answers / retries | 2 / 2 |

## Conflicts by kind

| Kind | Count |
|---|---|
| same-file edits on separate lines, landed as clean merges (both edits present) | 6 |
| identical edit pair, both landed (edit present once) | 2 |
| same-line variants (genuine conflicts) in the burst | 4 |
| train ejections MERGE_CONFLICT | 3 |
| conflicted changes: content conflict on shared/config.txt | 3 |
| resolve-conflict tasks opened | 3 |
| resolved through the task flow and published | 3 |
| incomplete (listed with reasons) | 0 |

## Requests and work counters

Harness requests: projected 3314, observed 1261 (ceiling 10000).

| Endpoint class | Requests | Summed x-kvarm-cost counters |
|---|---|---|
| `DELETE /agents/:id` | 100 | d1=200;rr=1099;rw=400;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `DELETE /repos/:o/:r` | 1 | d1=2;rr=1536;rw=716;art=1;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r` | 4 | d1=4;rr=12;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/changes` | 84 | d1=168;rr=27715;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/changes/:n` | 14 | d1=39;rr=183;rw=15;art=290;do=0;r2a=0;r2b=0;q=0;sub=4 |
| `GET /repos/:o/:r/forecast` | 3 | d1=6;rr=1656;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/queue` | 85 | d1=170;rr=2771;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/tasks` | 3 | d1=6;rr=27;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/workspaces` | 6 | d1=12;rr=1025;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/workspaces/:id` | 1 | d1=2;rr=7;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=1 |
| `GET /repos/:o/:r/workspaces/overlap` | 2 | d1=4;rr=2122;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /user` | 2 | d1=2;rr=5;rw=1;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /agents` | 100 | d1=200;rr=500;rw=600;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /agents/:id/tokens` | 100 | d1=400;rr=1200;rw=700;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /repos` | 1 | d1=3;rr=2;rw=6;art=1;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /repos/:o/:r/changes/:n/enqueue` | 104 | d1=210;rr=1254;rw=409;art=0;do=0;r2a=0;r2b=0;q=102;sub=0 |
| `POST /repos/:o/:r/tasks/:id/claim` | 3 | d1=15;rr=78;rw=42;art=0;do=0;r2a=0;r2b=0;q=0;sub=3 |
| `POST /repos/:o/:r/tasks/:id/complete` | 3 | d1=18;rr=411;rw=39;art=24;do=0;r2a=0;r2b=0;q=0;sub=15 |
| `POST /repos/:o/:r/workspaces` | 100 | d1=300;rr=1200;rw=1000;art=0;do=0;r2a=0;r2b=0;q=0;sub=200 |
| `POST /repos/:o/:r/workspaces/:id/change-set` | 99 | d1=396;rr=2470;rw=1584;art=1178;do=0;r2a=0;r2b=0;q=0;sub=99 |
| `POST /repos/:o/:r/workspaces/:id/dependencies` | 2 | d1=6;rr=25;rw=6;art=0;do=0;r2a=0;r2b=0;q=0;sub=2 |

| Server-side background work | Count |
|---|---|
| push events (D1 push_events) | 407 |
| push event deliveries | 407 |
| push event arrival after the Artifacts event, avg / max ms | 6151 / 54046 |
| push event effects completion after arrival, avg / max ms | 287 / 2086 |
| queue entries (published / other) | 99 / 3 |
| summed stored per-publication counters (merge_queue.cost) | d1=297;rr=991;rw=295;art=2;do=198;q=0;sub=198 |
| check runs recorded | 104 |
| snapshot commits (by state) | ready 95 |
| snapshot tree builds, summed build counters | 95: steps=285;d1=285;rr=1425;rw=760;art=5455;r2a=95;r2b=0;sub=0;treeReads=379;blobReads=4791;parts=0;objects=95;bytes=5197312;largestBlob=65744;peakBuffer=5197312;peakHeld=71427 |

## Checks

All 34 checks passed.

## Notes

- Pinned dependent w003 enqueue counters `d1=2;rr=16;rw=4;art=0;do=0;r2a=0;r2b=0;q=1;sub=0;cache=none` (the cost.md workspace-backed enqueue row was measured on unpinned changes).
- Pinned dependent w002 enqueue counters `d1=2;rr=15;rw=4;art=0;do=0;r2a=0;r2b=0;q=1;sub=0;cache=none` (the cost.md workspace-backed enqueue row was measured on unpinned changes).

Work counters (`x-kvarm-cost` classes and the stored per-publication counters) are application telemetry, not a Cloudflare bill. They come from one measured run of this workload and are not a service-level objective.
