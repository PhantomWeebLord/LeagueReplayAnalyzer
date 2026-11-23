<img src="static/logo.png" alt="Replay Analyzer logo" width="96">

# Replay Analyzer for League of Legends

Open a League of Legends replay (`.rofl`) and get a chess.com-style **Game Review**, plus a **live coach** that prepares you before a game and debriefs you the moment it ends.

**New in v2: the real replay instead of a recreation.** The map area shows League's own replay player, live, inside the app:
- League plays the replay; the app shows its window (a capture of that one window, nothing else on screen) and drives it through Riot's **Replay API**: every seek, the play/pause button, speed, *Watch this moment*, stepping through moves and the turning points jump League's replay to that moment.
- The eval bar, chart, moves list and coach notes stay in sync with League's replay clock.
- Champion bar under the replay: lock League's camera onto a player. Fog of war toggle, full screen, close replay.
- **Limit:** League only plays replays from its **current patch**. Older replays automatically use the recreated map (it's still one click away as *Recreated map*).
- One-time setup (one button in the app): replay control adds `EnableReplayApi=1` to League's `game.cfg` (a backup is kept).

**Ask Claude (v2):** a chat tab next to *Moves*. Select a move (or click *✦ Ask Claude* on it) and ask whether it was right and what to do instead. Each question goes to Claude (`claude-opus-5-5`) with a snapshot of the game: the selected move and its grade, gold/XP/kills/objectives at that moment, who was alive, and the events around it. Claude checks its answer with tools over a local index of NA Master+ solo-queue games that you build yourself (`coach/highelo_index.json.gz`, see [Data and privacy](#data-and-privacy)):
- `similar_situations`: games where a team was in the same spot (minute, gold lead, dragons, towers), how they ended, and what high-elo teams did next.
- `objective_value`: what dragon/grubs/herald/baron/towers were worth (win rate vs what the gold lead alone predicts), and what got traded.
- `after_fight`: what teams converted fights into (and how that went).
- `jungle_patterns` and `champion_benchmarks`: where Master+ junglers are by minute, and gold/CS/level benchmarks per champion.

It uses your own Anthropic API key (console.anthropic.com; billed per use, separate from a Claude.ai subscription; the cost of each answer is shown). The key is saved in the app's `config.json` (or set `ANTHROPIC_API_KEY`). Rebuild the index after downloading new games: `python train/build_coach_index.py`. Chat effort can be set with `"chatEffort"` in `config.json` (default `high`).

- **Every action graded** as **Brilliant !! · Great ! · Good ✓ · OK • · Inaccuracy ?! · Miss ✗ · Mistake ? · Blunder ??**, by how much it changed your team's win chance compared with the same kind of action in Master+ games. Each grade comes with an explanation and what would have been better. Grades roll up into an **accuracy %** per player, team and game phase.
- **Win chance**: an eval bar and chart from a model trained on thousands of high-elo ranked games, with a breakdown of what's driving it (gold, objectives, numbers, map, vision, XP).
- **Cinematic map** of all 10 players: movement follows real routes (lanes, river, jungle paths) instead of straight lines. It adds glowing trails, kill and objective effects, broadcast-style captions, a kill feed, and a **Director cam** that zooms onto fights and objectives (with slow motion).
- **Game story**, control phases, turning points (the biggest win-chance swings) and objective setups.
- **Trends** across all your replays: accuracy over time, recurring mistakes, weakest phase, champions, roles.
- **Live coach**: a focus card before your game, a recorder during it, and an automatic debrief after it. **Replay coach**: watch a replay in League and the app follows along, commenting on each graded moment.

## Run it

On Windows with Python 3.9+:

```powershell
python -m pip install -r requirements.txt
python server.py
```

Or double-click `start.bat`. The app opens in its own window. To analyse a game, pick it from the list, use *Open .rofl…*, or drag a `.rofl` file onto the window. The only extra package is `anthropic`, used by the chat.

**Build a single exe:** run `python -m pip install pyinstaller`, then `python build_exe.py`. The result is `dist\Replay Analyzer v2.exe`. You can copy it anywhere; it keeps its data in `%LOCALAPPDATA%\League Replay Analyzer` (put an empty `portable.txt` next to the exe to keep data beside it instead). It closes itself about 30 seconds after you close its window, but never while it's recording one of your games.

> The exe isn't code-signed, so Windows SmartScreen may warn the first time ("More info → Run anyway").


## Where the data comes from

A `.rofl` stores the game's network packets, encrypted per patch, so positions can't be read from it directly. The app reads the replay's metadata (game ID, the 10 players) and loads the official match timeline:

| Source | Needs | Works for | Includes |
|---|---|---|---|
| **League client** | League open and logged in | All games in your match history, **including custom games** | Positions every minute, kills, towers, objectives |
| **Riot API** | Free key from [developer.riotgames.com](https://developer.riotgames.com) (dev keys expire every 24h) | Ranked / normal games | All of the above plus wards, item purchases, level-ups, turret plates |
| **Live recording** | The app open while you play | Games you played with the app running | Exact item buys, levels, CS and vision score for all 10 players every 2 s, plus your gold and health |

Everything is cached, so each game downloads once. A game you played with the app open is automatically enriched with its live recording. For custom games this is a big improvement: in testing, recall detection went from 63 of 102 to 100 of 102, timing error from 9 s to 1 s, and average position error from about 550 to 110 units.

## Live coach (and why it's quiet during games)

- **Before the game** (lobby / champ select): your top recurring mistakes with tips, goals for deaths, CS/min and vision/min, and your history on the champion you lock in. All of it comes from your past games.
- **During the game**: a calm panel with only your own stats against those goals. The app records the official **Live Client Data API** that the game serves on your PC.
- **When the game ends**: the full graded review opens automatically, with a debrief of your goals against what actually happened.

It deliberately gives **no real-time advice** ("back now", "go dragon"), power-spike alerts or enemy timers. Riot's developer policies prohibit "apps that dictate player decisions" and apps providing "game-session-specific information that would be previously unknown to the player". Breaking that could put your account at risk. The app only reads Riot's official local APIs; it never reads game memory or the screen.

**Replay coach:** open a replay (in League, or with **▶ Watch in League** in the app). The review follows the replay's clock, and coach commentary pops up as each graded moment plays. To jump the League replay from the app's move list, click *Enable replay control* in the Live tab. This adds `EnableReplayApi=1` to League's `game.cfg` and keeps a backup; restart the replay for it to take effect.

## How the analysis works — and its limits

The analysis is **trained on high-elo games**: 5,885 ranked solo/duo games of Challenger, Grandmaster and Master players (NA, patches 16.18–16.23), downloaded from the Riot API. Another 1,445 games are kept out of training and used only to test it. The model only learns from Riot's once-a-minute snapshots, so it never sees information from after the moment it is judging. The trained result is in this repository; the downloaded games are not.

1. **Win chance.** A logistic regression predicts each team's chance to win from the game state at that moment: gold (kill bounties counted at the moment of the kill), XP, towers by tier, inhibitors down, drakes, soul, Baron/Elder buffs, Voidgrubs, Rift Herald, champions alive, enemy death timers, territory (who has presence where, from champion positions and towers), forward positioning and wards. Its weights change smoothly with game time, so a 2k lead at 10 minutes is worth less than at 30. Every weight is constrained to be ≥ 0, so having more of anything can never lower your chances. The *How it works* tab lists what each thing is worth at 15:00 and 30:00.
2. **Every action is valued by how much it moved the win chance**, in percentage points:
   - **Deaths**: the death itself (the same moment with you alive and no bounty paid), plus your share of what the enemy took while you were dead, minus what your team got for it.
   - **Fights**: the swing from just before to just after. **After a won fight**: what the team did with it over the next 90 s.
   - **Objectives**: their value at that moment, minus anything traded for them.
   - **Laning**: your 14:00 gold + XP lead over your lane opponent, converted to win chance.
3. **Grades are percentiles of high-elo play.** The same measurement was taken for every death, fight, single kill, objective and lane in all 5,885 training games. A death is an *Inaccuracy* when it cost more than 60% of high-elo deaths, a *Mistake* above 85%, a *Blunder* above 96%. Fights, single kills, objectives, conversions and lanes have their own bands (see the *How it's scored* tab). Farming and vision are compared with Master+ players in the same role.
4. **Validation** (games the model never saw):
   - **Prediction:** in a five-way test, each of the 7,330 games was judged by a version of the model that never trained on it. It named the eventual winner **72.1%** of the time (95% range 71.6–72.7%), against 71.4% for the old hand-set score and 71.0% for gold lead alone. Its probabilities are better too (log loss 0.524 vs 0.538 and 0.541). The shipped model's own 1,445 held-out games were an easier-than-average slice (73.5%); on them, when it said 75%, that team won 76.0% of the time.
   - **What the extra data did and did not change:** tripling the training games left winner calls unchanged on the same held-out games (73.5% before and after; log loss 0.5117 to 0.5111). The larger set mainly makes the grade bands and objective values more reliable. Ward data did not measurably improve prediction.
   - **Grading:** in the held-out games winners averaged **82.5** accuracy and losers **73.3**, and the more accurate team won 96.5% of games. This is a consistency check, not independent proof: grades measure win-chance swings, so the team that wins naturally collects better grades.
   - **Ordinary games:** on a separate set of 87 lower-elo ranked and custom games, it called the winner in 70.0% of minutes, about the same as the old score (71.0%).

Custom games have no ward data, so they use a second version of the model trained without vision.

**Limits:**
- **Correlational, not a search engine.** It measures what an action did to the win chance and compares it with high-elo outcomes. It can't play out the alternatives the way a chess engine does, so it can't name the single best move.
- **Approximate positions between known points.** They're exact once a minute and at events, routed along lanes and jungle paths in between.
- **No information on HP, cooldowns, item spikes or ward locations** (except your own HP and gold when recorded live).
- **High-elo standard.** Grades compare you with how Master+ games usually go, which is a high bar on purpose.

To retrain (for example on a new patch): put your own Riot API key in the app, run `python train/fetch_highelo.py`, then `python train/train_server.py` and click *Run everything* at <http://127.0.0.1:8771/>. That rewrites `static/wp_model.js`. Run `python train/build_coach_index.py` to refresh the chat's index, then rebuild the exe.

## Self-test

Add `?selftest` to the app's address to run every replay in your folder through the full pipeline and check for errors.

## Files

- `server.py`: app server: HTTP, app window, single-instance, auto-exit, local-only request checks
- `lra_core.py`: replays, Riot API, League client, Data Dragon assets, game config
- `lra_live.py`: live game recorder (Live Client Data API)
- `lra_coach.py`: Ask Claude: chat loop (Anthropic SDK, streaming, tools) and the Master+ lookups · `static/chat.js`: the chat tab · `train/build_coach_index.py`: builds `coach/highelo_index.json.gz`
- `static/model.js`: movement (routed paths), territory, win-chance features, fights, phases, live enrichment
- `static/wp_model.js`: the trained win-chance model, grade calibration and Master+ role benchmarks (generated)
- `static/review.js`: action grading, accuracy, coach's notes, game story
- `train/`: high-elo downloader (`fetch_highelo.py`), training server and page (`train_server.py`, `train.html`, `train.js`); downloaded games go in `train/data/` (git-ignored)
- `static/mapview.js`: cinematic map renderer · `static/live.js`: live coach · `static/trends.js`: Trends
- `static/app.js`, `index.html`, `style.css`: the UI · `static/selftest.js`: self-test
- `build_exe.py`: builds `dist\Replay Analyzer v2.exe` and draws the logo
- `config.json`, `cache/`, `live/`: your keys, cached matches and live recordings (git-ignored)

## Data and privacy

- This repository contains **no API keys, replays, player names or downloaded match data**. Your keys and games stay on your PC in git-ignored files.
- `static/wp_model.js` holds only model weights and aggregate statistics.
- **The chat's Master+ index is not included**, because Riot's API terms restrict redistributing game data. Everything else works without it. To enable *Ask Claude*, add your own Riot key in the app, then run:

```powershell
python train/fetch_highelo.py --target 2000
python train/build_coach_index.py
```

## Riot API use

Use your own key and never commit it. Riot requires products that serve players to be registered through the [Developer Portal](https://developer.riotgames.com), so register your build before distributing it. See Riot's [General Policies](https://developer.riotgames.com/policies/general).

## License

The code is released under the [MIT License](LICENSE). The license does not grant any rights to Riot Games' intellectual property.

Replay Analyzer isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
