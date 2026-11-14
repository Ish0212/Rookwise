# Rookwise

Open-source personal chess practice. Play our custom opponent, import your Chess.com or Lichess history, and turn real positions into puzzles.

**Status: local prototype.** The opponent has its own search and evaluation. Its level and learned move preferences are experimental, not a trained human-move model or certified Elo rating.

## Start

Requires Node.js 22 or newer:

    git clone https://github.com/Ish0212/Rookwise.git
    cd Rookwise
    npm install
    npm --prefix server install
    npm start

Open **http://localhost:3001**, keeping the server running. Opening index.html directly does not work. No API keys or chess-account passwords are required.

## Try the hosted demo

Use the [Render deploy blueprint](https://render.com/deploy?repo=https://github.com/Ish0212/Rookwise). It builds the included Dockerfile and health-checks the Node app. Render generates the public URL after you connect the public repository and deploy. The free service may sleep when idle, making the first request slower. Player data stays in each browser; no server database is configured.

## Play and adapt

- Play either color, choose promotions, review moves, flip the board, take back during a live game, and export PGN.
- Resign with confirmation. Reload preserves the game and resignation result.
- Choose a numeric opponent level from **400 to 2200**. It is an estimated practice scale, not measured Elo.
- Play, Train and Opponent are separate screens. Navigating preserves the current game.
- New games and position rematches replace the saved game.

### Our opponent

Gameplay uses our own bounded worker-thread engine: material and positional evaluation, shallow iterative search, and sampling among plausible moves. **Stockfish does not select gameplay moves.**

Balanced, Attacking and Careful are explicit preferences. Local memory learns position-specific move frequencies and capture/check/queen tendencies. These apply small biases within the candidate-quality band. Public imports learn only the account owner's moves; PGNs learn the side selected for review.

This is an inspectable learning mechanism, **not a pretrained human-move model**. It does not establish human-like cognition, general improvement or faithful historical style imitation. Those require training data and evaluation beyond this prototype.

### Performance-led level

After a completed standard game, including resignation, Rookwise samples up to 12 of your moves across the game. Local Stockfish analysis compares before/after positions.

A median and capped mean keep one blunder from dominating. Move quality leads the adjustment; the result has a smaller influence. A well-played loss can raise the level, while a poorly played win can lower it. Small samples reduce the adjustment. Fewer than three analyzed moves cannot raise it. Games under eight plies and position rematches do not count.

Opponent shows the signed change and explanation. Changes are bounded to 90 points per game. This is a heuristic, not calibrated performance Elo. Saved snapshots replay earlier settings, not your historical move choices.

## Import and train

1. Open **Train**, choose Chess.com or Lichess, and enter a public username, @name or matching profile URL.
2. Select **10, 100, 1,000 or 5,000 games** and all dates, the last week or last two weeks.
3. Follow progress, stop or resume. Sequential batches contain at most 100 games. Provider availability and rate limits apply; malformed/nonstandard games are skipped.
4. Select a game, confirm your side, and analyze it. Alternatively upload/paste PGN: up to 20 games, 750 KB and 600 plies per game.
5. Solve puzzles, inspect source moves and engine continuations, or **Run it back** against the custom opponent.

Review currently compares your last 12 moves using short 450 ms searches. Importing does not automatically analyze every game. Puzzles accept the selected engine line; other strong moves may exist. Short searches can miss tactics. Reports describe the reviewed sample rather than diagnosing a stable weakness from one game.

## Storage and networking

Sessions, profiles, observed moves, reports and puzzles are browser-local. Large imported libraries use IndexedDB and compact moves. If IndexedDB is unavailable, the full library lasts for the session but only 20 games persist in a localStorage fallback. Keep original PGNs.

Positions/PGNs go to your local Node server. Public imports contact Chess.com or Lichess from that server. They do not authenticate account ownership or access private games. There is no account system, cross-device sync or shared training database.

Default binding is 127.0.0.1; PORT and HOST can override it. Public source does not mean a hosted production service has been deployed. Multi-user hosting still needs identity, durable storage and operational controls.

## Architecture

| Files | Purpose |
| --- | --- |
| app.js, index.html, styles.css | Gameplay, views, resignation and performance review |
| personal.js, memory.js | Calibration, settings and observed moves |
| training.js | Imports, local library, puzzles and evidence |
| server/custom-engine.js | Our gameplay engine in worker threads |
| server/stockfish-engine.js | Separate queued analysis teacher |
| server/public-import.js | Provider pagination, filters and cursors |
| pieces.js, licenses/ | Licensed Chessnut artwork |

## Test and contribute

    npm test

Tests cover custom-engine tactics/responsiveness, real Stockfish, thousand-game pagination, provider failures, imports, stop/resume, resignation and quality-led progression. DOM tests execute actual modules using Node's experimental VM-module support. Desktop/mobile visual browser QA remains unverified in the current development environment.

See [CONTRIBUTING.md](CONTRIBUTING.md), [TODO.md](TODO.md) and [PLAN.md](PLAN.md).

## License and credits

Original Rookwise code is **MIT licensed**; see [LICENSE](LICENSE). Chessnut artwork by Alexis Luengas is Apache-2.0; see [THIRD_PARTY.md](THIRD_PARTY.md). Stockfish is a separate GPLv3 analysis dependency, and chess.js uses BSD-2-Clause. Dependencies retain their licenses.

The interface takes layout cues from Lichess's public source and Chess.com's navigation. No Lichess application source or Chess.com artwork is bundled. Rookwise is independent and unaffiliated with either service.
