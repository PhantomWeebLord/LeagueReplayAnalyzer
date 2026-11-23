# Phase 1 audit: Replay Analyzer v2

> A snapshot of the code before hardening. See [REPORT.md](REPORT.md) for what was fixed.

Audited commit: `c40d629`. 15 source files, 6,345 lines, plus `static/index.html` and the release workflow. No repository files were changed.

**Evidence labels.** **Confirmed** means the defect was reproduced with stubs or temp data. **Read** means it follows directly from the code but was not executed.

## 1. Dependency map

**Python**

```text
server.py ──> lra_live.py ──> lra_core.py
    └───────────────────────> lra_core.py
build_exe.py, train/fetch_highelo.py, train/train_server.py: standalone
```

No circular Python imports. Third-party runtime dependencies: none.

**Browser scripts** share one global scope and load in this order:

```text
wp_model → model → review → app → mapview → trends → live → replaystage → selftest
```

| Script | Uses globals from |
|---|---|
| `model.js` | none at load; `window.WP_MODEL` at run time |
| `review.js` | model |
| `app.js` | model, review, mapview, trends, live, replaystage |
| `mapview.js` | app, model, replaystage, review |
| `trends.js` | app, live, model, review |
| `live.js` | app, model, replaystage, review, trends |
| `replaystage.js` | app |
| `selftest.js` | app, mapview, model, review |

**Real circular dependencies:** `app ↔ mapview`, `app ↔ trends`, `app ↔ live`, `app ↔ replaystage`, `live ↔ trends`. They work only because the calls happen after every script has loaded. My scanner also reported `app ↔ model`, `app ↔ review`, `model ↔ review` and `model/review ↔ trends`; those are false positives from local variables named `S`, `T`, `$` and `names`.

## 2. Findings by severity

### Critical

| ID | Finding | Where | Evidence |
|---|---|---|---|
| C1 | **Close Replay can force-kill a real game.** It refuses only when the recorder status is `play`. If the live API is silent for over 6 seconds (loading screen, freeze, reconnect), status becomes `idle`, the game window still exists, and the app runs `taskkill`, then `taskkill /F`. In ranked this can mean a leave penalty. | `server.py:333-357`, `replaystage.js:247,376` | Confirmed |

### High

| ID | Finding | Where | Evidence |
|---|---|---|---|
| H1 | A brief config read failure returns `{}`, and the next save **erases the API key and settings**. | `lra_core.py:57-61`, `server.py:209-215` | Confirmed |
| H2 | If the end-of-game save fails once, the **final recording is never written**. | `lra_live.py:175-181` | Confirmed |
| H3 | League's `game.cfg` is rewritten non-atomically. A crash mid-write can damage it. The edit also changes line endings and removes blank lines. | `lra_core.py:538-554` | Confirmed (rewrite), Read (crash) |
| H4 | A just-finished game that 404s is marked **permanently unavailable**, so it never upgrades to richer Riot data. Riot publishes matches with a delay, so the auto-debrief path hits this. | `lra_core.py:250-262` | Confirmed |
| H5 | A malformed HTTP 200 from Riot is **cached as a valid game forever**. No response is validated. | `lra_core.py:242-246` | Confirmed |
| H6 | No retry, backoff, `Retry-After` handling or rate limiter on app Riot calls. Trends can burn a key's quota and fall back to poorer data. | `lra_core.py:192-210` | Confirmed |
| H7 | Two processes can bind the same port on Windows, so the "port busy" fallback never fires and another local process could sit on the app's address. | `server.py:361-365,437-445` | Confirmed |
| H8 | Cut connections and lockfile races escape as raw errors, skipping the League-client fallback. | `lra_core.py:196-210,335-336` | Confirmed |
| H9 | A corrupt champion table, or valid JSON of the wrong shape in the match cache, breaks that lookup until the file is deleted by hand. | `lra_core.py:222-232,373-375` | Confirmed |
| H10 | Atomic writes fail with `PermissionError` on Windows while another thread is reading the same file. | `lra_core.py:64-72`, `lra_live.py:248-254` | Confirmed |
| H11 | **Broken game data produces confident grades.** No frames, a missing player, or text where gold should be all yield a normal review with no warning. No participants passes analysis, then crashes `openReplay` and leaves the UI on "Loading". | `model.js:153-246`, `app.js:239` | Confirmed (analysis), Read (UI) |
| H12 | URF and other special modes on Summoner's Rift are graded against Master+ norms with no warning. The check looks only at the map. | `model.js:156` | Confirmed |

### Medium

| ID | Finding | Where | Evidence |
|---|---|---|---|
| M1 | State-changing GET: a cross-site page can force re-downloads with `/api/match?refresh=1`, because a missing `Origin` is accepted. | `server.py:68-75,127-134` | Confirmed |
| M2 | Internal exception text reaches API responses and the UI. Malformed JSON returns HTTP 500. | `server.py:144-145,189-190,265-266` | Confirmed |
| M3 | No resource limits: unbounded POST body, whole-file rofl fallback read, unbounded network reads. | `server.py:200`, `lra_core.py:103-104,197,378,512`, `app.js:177` | Read |
| M4 | The parser requires `gameLength` to be the first metadata key. If Riot reorders the JSON, **every replay stops parsing**. | `lra_core.py:99,105`, `app.js:179` | Confirmed |
| M5 | One odd player field rejects a whole replay, and parser exceptions are shown raw. | `lra_core.py:110,125-143,174-175` | Confirmed |
| M6 | Two independent rofl parsers (Python and JS) with different rules. | `lra_core.py:85`, `app.js:176` | Read |
| M7 | One offline start pins Data Dragon to hardcoded `15.1.1` until restart. | `lra_core.py:475-487` | Confirmed |
| M8 | Asset and version cache writes aren't atomic, so a truncated image is served forever. | `lra_core.py:484,513` | Read |
| M9 | A successful match response is discarded when the timeline call fails, then fetched again. Concurrent opens duplicate calls. | `lra_core.py:241-246` | Confirmed |
| M10 | Any 403, including a firewall block, marks a valid key as rejected until restart. | `lra_core.py:248-249` | Read, and seen in this project with error 1010 |
| M11 | Every League-client call probes up to 18 install paths across drives C–H, which can stall on sleeping drives. | `lra_core.py:274-287` | Read |
| M12 | A malformed live recording blocks that game's review. | `model.js:96-150` | Confirmed |
| M13 | Patch-sensitive constants (death timers, ward lifetimes, non-purchase item IDs) apply to all patches. | `model.js:16,94,531` | Read |
| M14 | A model trained on 16.18–16.23 grades 15.x and future patches with no warning. | `model.js:625-629` | Confirmed (99.1 accepted) |
| M15 | Silent failures: 9 silent Python handlers, disabled request logging, recorder errors never surfaced, and a crash in the ID-linking thread loses the link silently. | `server.py:65`, `lra_live.py:133-135,218-246` | Read |
| M16 | Live recordings, cache and `app.log` grow without limit. | `lra_live.py:248`, `server.py:429` | Read |
| M17 | The release workflow publishes after a start check only. There are no tests. | `.github/workflows/release.yml` | Read |

### Low

| ID | Finding | Where |
|---|---|---|
| L1 | `taskkill` is resolved through the search path instead of System32. | `server.py:349,354` |
| L2 | League's local APIs are called with TLS verification off. Expected for its self-signed certificate, but the client password goes to whichever process holds that port. | `lra_core.py:345`, `lra_live.py:102` |
| L3 | No `X-Content-Type-Options` or Content-Security-Policy headers. | `server.py:77-92` |
| L4 | Self-test output inserts replay-derived text into HTML unescaped. | `selftest.js:58` |
| L5 | Bad `--port` or `LRA_PORT` values crash at startup with no message in the windowed exe. | `server.py:35,46` |
| L6 | The trainer's region table is missing `ME1`, `PH2` and `TH2`. | `fetch_highelo.py:29` |
| L7 | The trainer can loop forever if every queued game keeps failing. | `fetch_highelo.py:276-293` |
| L8 | Concurrent debriefs can overwrite each other's "already shown" list. | `live.js:122,134` |
| L9 | The key hint exposes four key characters to the local page. | `server.py:115` |

## 3. Code smells

- **Long functions:** 34 over 30 lines. Largest: `tabHowTrained` 186, `drawMap` 175, `renderTrends` 164, `renderLive` 103, `fetch main` 99, `reviewFights` 98, `buildGame` 94, `do_GET` 92, `drawChart` 92, `reviewDeath` 87.
- **Dead code:** the `|| true` filter (`model.js:887`), unused `total` (`model.js:951,962`), the always-hidden Watch in League path (`app.js:249`, `live.js:249`), and unused `tm` parameters (`app.js:384,386`).
- **Duplication:** rofl parsing, region tables, `fmtWp`/`fmtWp1`, `avg`/`avgOf`, `objValue`/`objValueOf`, death analysis in both `reviewDeath` and `playerReport`, repeated `team === 100 ? a : b` selectors.
- **Magic numbers:** grade cutoffs, fight windows (15 s, 3500 units), objective timers (150/180/300), phase boundaries (840, 1500), UI poll intervals, Win32 flags.
- **Density:** lines up to 882 characters, many statements per line, and deeply nested template literals.

## 4. Missing error handling

| External call | Gap |
|---|---|
| Riot API | `IncompleteRead`, no retry, no schema check |
| League client | Lockfile read, malformed JSON, partial lockfile |
| Data Dragon | Corrupt cache read; shape of version list and champion data unchecked |
| Config | All errors become `{}` |
| Replay copy into League's folder | Non-atomic, so an interrupted copy leaves a partial `.rofl` |
| `game.cfg` | Non-atomic write |
| Live recording save | No retry after a failed final save |
| Live session read | Corrupt file becomes a raw 500 |
| Browser `api()` | Ignores HTTP status; non-JSON responses throw |
| `init()` and `loadReplayList()` | Startup failure leaves a dead page |

## 5. Security

**Passed under test:** no secrets in tracked files, static path traversal blocked, DNS rebinding blocked, cross-site POST blocked. Replay-derived text is escaped in every normal UI view.

**Open:** M1, M2, M3, H7, L1–L4.

## 6. Architecture gaps

- `lra_core.py` holds seven jobs: config, rofl parsing, Riot API, League client, Data Dragon, game config and Win32 windows.
- `do_GET` and `do_POST` are long route chains that mix HTTP, validation and logic.
- `S`, `RS`, `LV` and `T` are shared mutable globals across scripts.
- HTML generation, grading rules and explanatory text are tangled in the same functions.
- There is no validated data model between Riot's JSON and the analysis.
- There is no game-mode or patch policy layer.

## 7. Replay-specific risks

| Risk | Current state |
|---|---|
| **Champion/item IDs** | Champions use Riot's stable internal IDs (`MonkeyKing`), with display names only for UI. Replay metadata has **no numeric champion ID**, so replay-to-game linking must use the internal ID. Item IDs are numeric but the non-purchase list is hardcoded. |
| **Missing/null fields** | See H11. Missing timestamps and invalid team IDs throw; other gaps silently degrade grades. One real replay has an empty player list, and 8 real participants have no role. |
| **Version mismatch** | Your replays span **19 patches (15.12–16.23)**. All parse. Grading uses one model for all (M13, M14). |
| **Rate limits** | The trainer handles 429 correctly; the app doesn't (H6). |
| **Corrupt/truncated `.rofl`** | Rejected without crashing the list, but messages are raw and a reordered metadata block fails (M4, M5). |
| **Game modes** | Ranked, normals, Clash and customs tested. ARAM blocked correctly. URF-style modes pass wrongly (H12). |
