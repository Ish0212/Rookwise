# Rookmate backend

Run npm start from the root. Default address: 127.0.0.1:3001.

- POST /api/move: {fen,rating?:400..2200,difficulty?:easy|medium|hard,style?:balanced|attacking|careful,preferences?:{uci:count},habits?:{captureRate,checkRate,queenRate}} returns {move:uci|null}. Custom worker engine. Difficulty is a legacy fallback when rating is omitted. Observed priors stay inside the candidate-quality band.
- POST /api/analyze: {fen} returns {move,cp,mate,pv,depth}. Stockfish full skill,450 ms. White-centric scores; terminal mate0 requires checking the side to move.
- POST /api/import: {pgn} returns {games}. Up to20games/750KB/600plies per game.
- POST /api/import/username: {provider:chesscom|lichess,username,limit?:1..100,since?:epochMs|null,cursor?:string|null} returns {games,nextCursor,done,provider,username,notice}. Follow cursors sequentially. Profile URLs map to fixed provider origins.

Custom searches have bounded effort, queue size and worker lifetime. Stockfish analysis is serialized with deadlines and recovery. Imports use sequential requests, response limits, caching and cooldown. No server game database or authentication is included.

Only explicit frontend assets are served. createApp/startServer support tests. npm test here runs backend unit tests; run it at the root for all checks.
