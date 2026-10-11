# Fleet run: 100 active workspaces and a paced change burst

Run 2026-10-11T07:23:52.014Z → 2026-10-11T07:37:10.604Z against the live worker (version 343607c6-df88-492e-a6b6-1cf061d111d7), driver `scripts/fleet-driver.mjs` at `8fb9b75`, scratch repo `cynthia/scale-staged-campaign-fleet-1791703431` (deleted afterwards).

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
| Burst window (first enqueue → last publication) | 504.1 s |
| Throughput (accepted publications per minute over the window) | 11.43 |
| Latency enqueue → published, server clock (p50 / p90 / max) | 61.0 s / 399.5 s / 504.1 s |
| Max queue backlog observed (active entries) | 64 |
| Longest interval with no queue entry reaching a terminal state | 306.6 s (+164.2 s → +470.8 s after the first enqueue; ended by #93 ejected MERGE_CONFLICT) |
| 429 QUEUE_FULL answers / retries | 1 / 1 |

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

Harness requests: projected 3314, observed 1336 (ceiling 10000).

| Endpoint class | Requests | Summed x-forge-cost counters |
|---|---|---|
| `DELETE /agents/:id` | 100 | d1=200;rr=1099;rw=400;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `DELETE /repos/:o/:r` | 1 | d1=2;rr=1527;rw=710;art=1;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r` | 4 | d1=4;rr=12;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/changes` | 123 | d1=246;rr=39340;rw=1;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/changes/:n` | 12 | d1=33;rr=161;rw=15;art=290;do=0;r2a=0;r2b=0;q=0;sub=4 |
| `GET /repos/:o/:r/forecast` | 3 | d1=6;rr=1652;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/queue` | 124 | d1=248;rr=2811;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/tasks` | 3 | d1=6;rr=27;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/workspaces` | 6 | d1=12;rr=1025;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /repos/:o/:r/workspaces/:id` | 1 | d1=2;rr=7;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=1 |
| `GET /repos/:o/:r/workspaces/overlap` | 2 | d1=4;rr=2122;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `GET /user` | 2 | d1=2;rr=4;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /agents` | 100 | d1=200;rr=501;rw=601;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /agents/:id/tokens` | 100 | d1=400;rr=1200;rw=700;art=0;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /repos` | 1 | d1=3;rr=2;rw=6;art=1;do=0;r2a=0;r2b=0;q=0;sub=0 |
| `POST /repos/:o/:r/changes/:n/enqueue` | 103 | d1=207;rr=1241;rw=408;art=0;do=0;r2a=0;r2b=0;q=102;sub=0 |
| `POST /repos/:o/:r/tasks/:id/claim` | 3 | d1=15;rr=78;rw=42;art=0;do=0;r2a=0;r2b=0;q=0;sub=3 |
| `POST /repos/:o/:r/tasks/:id/complete` | 3 | d1=18;rr=411;rw=39;art=24;do=0;r2a=0;r2b=0;q=0;sub=15 |
| `POST /repos/:o/:r/workspaces` | 100 | d1=300;rr=1200;rw=1000;art=0;do=0;r2a=0;r2b=0;q=0;sub=200 |
| `POST /repos/:o/:r/workspaces/:id/change-set` | 99 | d1=396;rr=2471;rw=1584;art=1174;do=0;r2a=0;r2b=0;q=0;sub=99 |
| `POST /repos/:o/:r/workspaces/:id/dependencies` | 2 | d1=6;rr=25;rw=6;art=0;do=0;r2a=0;r2b=0;q=0;sub=2 |

| Server-side background work | Count |
|---|---|
| push events (D1 push_events) | 406 |
| push event deliveries | 406 |
| push event arrival after the Artifacts event, avg / max ms | 5298 / 41856 |
| push event effects completion after arrival, avg / max ms | 388 / 59397 |
| queue entries (published / other) | 99 / 3 |
| summed stored per-publication counters (merge_queue.cost) | d1=297;rr=1492;rw=297;art=2;do=198;q=0;sub=198 |
| check runs recorded | 104 |
| snapshot commits (by state) | ready 91 |
| snapshot tree builds, summed build counters | 91: steps=273;d1=273;rr=1365;rw=728;art=5130;r2a=91;r2b=0;sub=0;treeReads=363;blobReads=4494;parts=0;objects=91;bytes=4880896;largestBlob=62763;peakBuffer=4880896;peakHeld=65824 |

## Checks

33 of 34 checks passed. Failed:

- [VAL-SCALE-004d] every per-publication stored counter set within the cost.md publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: 0/99 within

## Notes

- Pinned dependent w003 enqueue counters `d1=2;rr=15;rw=4;art=0;do=0;r2a=0;r2b=0;q=1;sub=0;cache=none` (the cost.md workspace-backed enqueue row was measured on unpinned changes).
- Pinned dependent w002 enqueue counters `d1=2;rr=16;rw=4;art=0;do=0;r2a=0;r2b=0;q=1;sub=0;cache=none` (the cost.md workspace-backed enqueue row was measured on unpinned changes).
- 1 pinned-chain `d1=3;rr=20;rw=3;art=0;do=2;q=0;sub=2` publication(s) outside the publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: #4.
- 1 pinned-chain `d1=3;rr=19;rw=3;art=0;do=2;q=0;sub=2` publication(s) outside the publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: #2.
- 1 unpinned `d1=3;rr=15;rw=3;art=2;do=2;q=0;sub=2` publication(s) outside the publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: #1.
- 94 unpinned `d1=3;rr=15;rw=3;art=0;do=2;q=0;sub=2` publication(s) outside the publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: #5, #6, #7, #8, #9, #10, #11, #14, #15, #12, #13, #17, ….
- 1 unpinned `d1=3;rr=13;rw=3;art=0;do=2;q=0;sub=2` publication(s) outside the publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: #25.
- 1 pinned-chain `d1=3;rr=15;rw=3;art=0;do=2;q=0;sub=2` publication(s) outside the publication row d1<=3;rr<=12;rw<=8;art<=4;do=2: #3.

Work counters (`x-forge-cost` classes and the stored per-publication counters) are application telemetry, not a Cloudflare bill. They come from one measured run of this workload and are not a service-level objective.
