# Production hardening report

This covers branch `polish/production-hardening`, based on `c40d629`. The original findings, with line references to that commit, are in [AUDIT.md](AUDIT.md).

## Result

- **819 tests pass:** 420 Python and 399 browser, with no new dependencies.
- **All 89 local games keep identical analysis**, checked after every change by fingerprinting every grade, number and sentence. The one ARAM game is still refused.
- **37 findings are fixed.** Three known limits remain open, listed below.
- Replays from **19 patches (15.12–16.23)** parse correctly.

## How to run the tests

```powershell
python tests/run_all.py
```

Browser tests use an isolated headless Edge or Chrome. Tests never touch your League install, real cache, or the internet.

## Refactors (no behavior change)

| Commit | Module | Change | Why it is safe |
|---|---|---|---|
| `ed778ad` | `lra_core.py` | Named constants; extracted rofl, Riot, client and version helpers | Same inputs reach the same calls; core tests unchanged |
| `aa063c7` | `lra_live.py` | Named timings; split state handling | Same state transitions; recorder tests unchanged |
| `cf0597d` | `server.py` | Route chains became handler tables | Same endpoints, statuses and bodies; HTTP tests unchanged |
| `3170ecd` | `train/fetch_highelo.py` | Download loop became a `Fetcher` class | New end-to-end loop tests written first |
| `47f6768` | `static/model.js` | Named game rules; removed dead code | All game fingerprints identical |
| `7c63db7` | `static/review.js` | Named grading thresholds | Every graded action identical |
| `aa1aae9` | `static/*` | Removed the unreachable Watch in League path; named timings | The button was always hidden; UI flow tests unchanged |

Retries, caching and validation change behavior by design, so they were done as tested fixes rather than refactors.

## Production review

| Severity | ID | What would break | Fix | Commit |
|---|---|---|---|---|
| Critical | C1 | Close Replay could force-kill a real game during a freeze or reconnect | Closes only a positively identified replay | `48278b4` |
| High | H1 | A brief config read failure erased the API key on the next save | Uses the last good config and keeps a damaged file | `8555778` |
| High | H2 | A failed end-of-game save lost the final recording | Failed saves retry on the next poll | `974a8dd` |
| High | H3 | Editing League's `game.cfg` was non-atomic and rewrote the file | Atomic write that changes only the replay setting | `2194819` |
| High | H4 | A just-finished game could be locked to poorer data forever | Recent 404s are checked again later | `28b6729` |
| High | H5 | A malformed Riot response was cached as a real game | Responses and cache entries are validated | `c449dc8` |
| High | H6 | No retry, backoff or rate limiting on Riot calls | Limiter, `Retry-After` and exponential backoff | `03c11a1` |
| High | H7 | Another process could bind the app's port | Port is exclusive on Windows | `01890b1` |
| High | H8 | Dropped connections and lockfile races crashed requests | Typed errors that reach the fallback | `9301f7d` |
| High | H9 | A damaged cache file broke lookups until deleted by hand | Damaged files are ignored and fetched again | `c449dc8`, `c846418` |
| High | H10 | Writes failed while Windows had the file open | Replacement waits and retries | `b361dd2` |
| High | H11 | Broken data got confident grades or a stuck page | Clear error, or repaired and noted | `08ebb56` |
| High | H12 | URF-style modes were graded with no warning | The review says grades are rough | `c33d9f4` |
| High | New | A rejected request could lose its 403 (found by the test gate) | Bodies are read before replying | `ee494c7` |
| Medium | M1 | Other websites could trigger forced re-downloads | Cross-site requests are blocked | `9f2f0a3` |
| Medium | M2 | Internal errors reached the page | Plain messages; details go to the log | `ee1b088`, `5670248` |
| Medium | M3 | No limits on bodies, responses or stalled clients | Size caps and timeouts | `ee494c7`, `83bfda5` |
| Medium | M4/M5 | A reordered metadata block or one odd field rejected replays | Parser tolerates both | `8d7ef4d` |
| Medium | M6 | The browser parser had weaker rules than the Python one | Same safeguards in both | `06d617d` |
| Medium | M7 | One offline start pinned an old Data Dragon version | Retries after a few minutes | `7c6335f` |
| Medium | M8 | Truncated images were cached forever | Images are checked before saving and serving | `6615fea` |
| Medium | M9 | Failed timelines wasted the match call; parallel opens duplicated calls | Partial results kept; one download per game | `89ea8a2` |
| Medium | M10 | A firewall block marked a valid key as rejected | Firewall blocks are told apart | `df5e704` |
| Medium | M11 | Custom installs were missed and drives were re-probed constantly | Uses Riot's install list, caches the result | `8a07da6` |
| Medium | M12 | A damaged live recording blocked that game's review | The recording is ignored | `a9d2e7d` |
| Medium | M14 | Patches outside the model were graded with no warning | The review says grades are approximate | `c33d9f4` |
| Medium | M15 | Background failures vanished silently | Logged and exposed in status | `0ea8dd0` |
| Medium | M16 | `app.log` could grow without limit | Rotated at 2 MB | `18d4b97` |
| Medium | M17 | Releases could publish without tests | Workflow runs the suite first | `2673e32` |
| Low | L1 | `taskkill` was resolved through the search path | Runs from System32 | `fbc6c5a` |
| Low | L3 | No browser security headers | CSP and `nosniff` | `09b16ae` |
| Low | L4 | Self-test output was not escaped | Escaped | `c27069d` |
| Low | L5 | A bad port crashed the windowed exe | Falls back to the default | `b857d1d` |
| Low | L6 | Trainer was missing three regions | Added | `fc6d39f` |
| Low | L7 | Trainer could loop forever on a failing game | Skipped after five attempts | `15ccb69` |
| Low | L8 | Simultaneous debriefs could overwrite their record | Read at write time | `ba3f234` |
| Low | L9 | The key hint exposed extra characters | Last four only | `7183e7e` |

### When Riot changes things

- **API shape changes:** invalid responses are rejected and never cached, and the app falls back to the League client.
- **Replay format changes:** the parser no longer depends on metadata key order. A file it cannot read gets a plain error and does not affect other replays.
- **A replay from a future patch:** it is analyzed with a visible warning that grades are approximate.
- **New monsters or event types:** unknown events are ignored, and unknown monsters keep their raw name.

## Still open

| Item | Why it remains | Impact |
|---|---|---|
| M13: patch-specific game rules | Death timers and ward lifetimes would need a per-patch rules table that the app does not have | Older replays are approximate, and the app now says so |
| M16: live recordings are never deleted | Automatically deleting a player's recordings is riskier than the disk use | Small: the recordings on the test PC average about 45 KB, and the largest is about 150 KB |
| L2: local TLS is not verified | League uses a self-signed certificate on localhost | Low; traffic stays on this PC |

Long rendering functions such as `drawMap` and `renderTrends` were left intact. They have no pixel-level safety net, so splitting them would risk visual changes the tests could not catch.

## Not verified

- A real game or real replay session in League after these changes. Those paths were tested against stubs, and the League client was closed during the final checks.
- The updated release workflow on GitHub, because this branch has not been pushed.
- A second physical PC.
