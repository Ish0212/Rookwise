# Chess AI

A local chess practice and training room. Play either color against Stockfish, import your games, and turn critical positions into personal puzzles and rematches.

## Run locally

Install Node.js 22 or newer, then run from the repository root:

```sh
npm install
npm --prefix server install
npm start
```

Open **http://localhost:3001** and keep the terminal running. `PORT` and `HOST` override the default local address. Opening `index.html` directly does not work; the Node server supplies engine moves and the local chess rules module.

## Play and train

- Choose White or Black and Easy, Medium, or Hard. Select a piece to see legal destinations. Castling, en passant, promotion choices, checkmate, and draws are handled by chess.js.
- Take back a turn, inspect move history, flip the board, and export PGN. Your current game resumes from browser storage after reload. New games and position rematches replace that saved game.
- Paste or upload PGN, or import public games by Chess.com/Lichess username. No chess account password is needed. Provider availability and rate limits apply.
- Select your side and review a game. The review compares up to your **12 most recent moves**, using short **450 ms** Stockfish searches before and after each move. Evaluation losses of at least one pawn produce personal practice positions.
- Solve, retry, reveal the engine suggestion, inspect the continuation and source move, or choose **Run it back** to play the original position. Attempts and solves are stored separately from game performance.
- The scouting report describes the reviewed sample and links its practice material to actual moves. It does not establish your overall skill or a stable weakness from a small sample.
- Opt into adaptive difficulty: after three unique completed standard games at the same level, results can move the next challenge one step up or down. Games under eight plies and position rematches do not count. This is a practice setting, not an Elo rating.
- Balanced, Attacking, and Careful rival preferences affect selection among engine candidates. Dated saved settings let you revisit an earlier challenge. This replays **past settings**, not a learned imitation of your historical moves.

## Limits and storage

This version does not train a shared model or learn from everyone's games. Personalization uses your imported material, saved practice results, and explicit settings. There is no shared training database, account system, or cross-device sync.

Games, reports, puzzles, and practice profiles are saved in this browser on this device. Clearing site data removes them; storage must be available. Keep original PGNs and export important games. PGN imports accept up to 20 games and 750 KB, with at most 600 plies per game. Public username imports are bounded; Chess.com searches a limited set of recent archive months.

Short analysis can miss tactics. A puzzle currently accepts the engine's selected move; other strong moves can exist. The report is a practice aid rather than a complete game review. Faithful past-self imitation, deeper weakness modeling, and shared learning remain future work in [PLAN.md](PLAN.md) and [TODO.md](TODO.md).

## Verification and code

```sh
npm test
```

Tests cover engine isolation and recovery, HTTP contracts, import parsing/provider behavior, and gameplay/training state in a DOM simulator. The test runner uses Node's experimental VM module support to execute the actual browser module graph. Real-browser visual and touch QA remains required when browser tooling is available.

- `index.html`, `styles.css`, `app.js`: board, game controls, replay and saved session.
- `training.js`, `personal.js`: imported-game practice and optional opponent settings.
- `server/`: bounded Stockfish process, HTTP API and game importers; see [server/README.md](server/README.md).
- `tests/`: interaction and integration regression tests.

No frontend build step or CDN dependency is needed. chess.js is served from the installed server dependency. Stockfish is distributed under GPLv3; retain its license when redistributing.
