# Chess AI server

From the repository root:

```sh
npm --prefix server install
npm start
```

Default address: **http://127.0.0.1:3001**. Configure `HOST` and `PORT` as needed. The server serves a fixed list of public frontend assets and the local chess.js ES module; repository source and dependencies are not served generally.

## API

- `POST /api/move` with `{fen,difficulty,style}` returns `{move}` in UCI notation, or `null` at game end. Defaults are `medium` and `balanced`. Difficulties: `easy`, `medium`, `hard`; styles: `balanced`, `attacking`, `careful`.
- `POST /api/analyze` with `{fen}` returns `{move,cp,mate,pv,depth}`. Centipawns and mate scores use White's perspective; terminal mate uses `mate:0`. Searches use full skill with a 450 ms analysis budget.
- `POST /api/import` with `{pgn}` returns `{games}` including headers, source positions and legal replay moves. Limits: 750 KB, 20 games, 600 plies per game.
- `POST /api/import/username` with `{provider,username,limit}` imports public history. Providers: `lichess`, `chesscom`; maximum 20 games. Chess.com searches at most three recent played archive months. Provider errors and rate limits are exposed as recoverable errors.

Stockfish runs as a separate child process. Searches are serialized, the queue is bounded, startup/search deadlines discard failed processes, and later requests can recover. Easy/Medium/Hard move searches use 150/450/1200 ms respectively. Rival styles choose among bounded engine candidates; they are presets rather than learned behavior.

The server does not store a shared game database or train a model. Browser storage holds personal sessions and derived practice material. Username import contacts the selected public service. Other API calls run locally. Invalid input returns 400, oversized JSON 413, and unavailable engines 503; remote import can return provider-specific 404/429/502/504 errors.

Run all checks with `npm test` at the repository root. The old `/api/games` global-sync endpoint has been removed.
