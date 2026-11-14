# Backend handoff — 2026-11-13

All edits are saved locally. No commit or push was made. Stop/resume requested by user via root agent due to usage limit.

## Implemented

- `server/server.js`: Express app exports `createApp({engine, importer})` and synchronous `startServer({port,host,engine}) -> {app,server,engine}`. Default localhost:3001. Port 0 logs actual assigned port.
- `POST /api/move {fen,difficulty?,style?}` returns `{move:uci|null}`. Difficulty easy/medium/hard defaults medium; style balanced/attacking/careful defaults balanced. FEN/difficulty/style invalid ->400; engine unavailable ->503.
- **Style API IS DONE**, including real engine smoke. Uses MultiPV5 for attacking/careful; chooses legal capture/check or quiet candidate, respectively, within60cp of best at same depth. Falls back to engine bestmove; preserves mate lines. These are explicit presets, not learned style models. Balanced uses MultiPV1.
- `server/stockfish-engine.js`: serialized bounded12-request UCI queue,10sec startup/ready timeout,8sec search timeout,32MB hash, exit/error handling, process discarded on failure and lazily restarted next request. Validates output legality via chess.js. Difficulty uses skill0/8/20 and150/450/1200ms.
- `POST /api/analyze {fen}` returns `{move,cp,mate,pv,depth}`. CP and mate are WHITE-centric. Full skill20 at450ms per position. Terminal draw cp0/mate null; terminal checkmate cp null/mate0. No persistent engine process before first request.
- `POST /api/import {pgn}` returns `{games:[{headers,result,initialFen,finalFen,moves:[{san,uci,color,before,fen}]}]}`. Max20games/750000 PGN chars/600plies per game. Common multi-game exports split on Event header. No storage backend; frontend handles local persistence.
- `POST /api/import/username {provider:'lichess'|'chesscom',username,limit?:1..20}` (default10) -> `{games:[same shape],provider,username,notice}`. Public finished standard games only; Chess.com examines up3latest played months. Fixed hosts and constructed paths, no arbitrary URL input, validated usernames, redirects disallowed, requests serialized, bounded4imports queued, total25sec timeout,5MB response cap,429 cooldown60sec and Retry-After60. Errors400validation,404not found,429rate limit,502provider,504timeout.
- Static allowlist: `/`, `/index.html`, `/app.js`, `/styles.css`, `/training.js`, `/personal.js`, `/vendor/chess.js` (installed chess.js ESM). Backend source/dependencies/git not exposed. Legacy games/analyzePositions endpoints removed.
- Installed chess.js,express,stockfish in server; removed unused cors. server npm cache was redirected to `server/.npm-cache` to work within sandbox. Root gitignore ignores `.npm-cache/` and node_modules.

## Verified

- `cd server; node --test public-import.test.js stockfish-engine.test.js`: **14/14 pass**, latest after style edits. Tests cover serialization, score sign, timeout startup/search recovery, exit recovery, illegal engine move, queue bounds, PGN replay, remote endpoint construction/user-agent, rate cooldown, response limits, username validation, and styles within60cp/mate preservation.
- Real Stockfish smoke: legal moves for all three styles with easy difficulty; separate earlier four-turn smoke by validation agent; opening analysis white-to-move cp+37 and after e4 black-to-move cp+36 demonstrating consistent score perspective.
- **LIVE imports passed**: Lichess `thibault`1game, Chess.com `hikaru`1game.
- Before latest remote/style additions validation agent reported full root suite21/21 pass. It owns root tests/docs and may add remote/style route coverage.

## Remaining / resume

1. Tell/confirm UI wires style select to optional move `style` field. UI was told contract before implementation, but final readiness notice may still be needed.
2. Run final full root `npm test` and browser/manual integration after all UI/personal modules land. Parent/validation agent own these.
3. Update server README/root docs with remote import and style details if validation agent has not already done it.
4. Review scoped/realistic limitations: short450ms tactical analysis can miss tactics; no learned style model; Chess.com public data may be delayed; import limits intentional; username import does not authenticate ownership or access private games.
5. Optional hardening after resume: dedicated upstream timeout test, sender cancellation of queued analysis, more robust uncommon PGN multi-game splitting without Event headers. No known blocker for normal exports.

## Official provider references checked

- https://www.chess.com/news/view/published-data-api (archive list,monthly JSON,serial rate policy).
- https://lichess.org/api
- https://raw.githubusercontent.com/lichess-org/api/master/doc/specs/lichess-api.yaml (User-Agent mandatory,one request at a time,429 backoff).
- https://raw.githubusercontent.com/lichess-org/api/master/doc/specs/tags/games/api-games-user-username.yaml (public export,max,standard perfType,finished/ongoing,PGN response).
