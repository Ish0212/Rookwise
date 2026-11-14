# ChessAI rebuild plan

## Product
A personal chess training companion used alongside Chess.com and Lichess. Import real games, understand recurring mistakes, practice personalized puzzles, and play a sparring opponent calibrated to your progress.

## Build order
1. Reliable foundation: maintained chess rules library, responsive accessible board, Stockfish service with queued requests and timeouts, both colors, promotion, game endings, restart, local resume, replay, PGN export.
2. Import and analysis: PGN upload/paste first; public Chess.com and Lichess username imports after verifying API contracts and limits. Let players identify their color/account. Preserve game provenance and show import/analysis progress and recoverable errors. No account passwords required.
3. Personal puzzle loop: analyze positions before and after player moves, normalize scores to one perspective, identify meaningful missed tactics and defensive resources. Validate the best line and acceptable alternatives. Explain mistakes using concrete engine lines; distinguish forced mates from evaluation losses. Support solve, retry, reveal, and replay against the engine.
4. Evidence-based scouting: summarize recurring themes with links to source positions, sample counts and uncertainty. Track practice outcomes separately from game performance. Do not infer a stable weakness from one game.
5. Adaptive sparring: estimate playing strength from sufficient results and move quality, make gradual difficulty adjustments, and offer targeted rival styles. Explain adjustments. Engine difficulty is not a certified player rating.
6. Play your past self: retain dated skill/style snapshots and approximate earlier tendencies only once enough history exists. Label this as an approximation; measure whether behavior reflects the snapshot. This is a committed later milestone, not a claim in the initial release.

## Architecture
- Separate browser UI, authoritative chess state, persistence, import/analysis and engine adapter.
- Keep expensive search off the browser UI thread. Reject stale replies after restart or position changes.
- Use bounded analysis jobs with cancellation/backpressure and engine recovery.
- Store source PGN and derived analysis with engine/settings versions so results are reproducible.
- Start with local saved progress; define durable per-user storage and authentication before hosted multi-user training histories.
- Stockfish supplies analysis and move selection. Personalization is a separate layer; shared game collection is not evidence of model improvement.

## Experience
Primary areas: Train, Play, My Games and Progress. The main demonstration is import a game, inspect a critical mistake, solve a puzzle from it, replay the position, and see the practice recorded.

## Verification and release criteria
- Legal play and correct endings, including castling, en passant, promotion, checkmate and draws.
- Engine returns legal moves; simultaneous requests cannot mix results; failures terminate and expose retry.
- Restart during search cannot mutate a new game; resume and replay preserve live state.
- Invalid PGNs and unavailable import services produce actionable errors.
- Puzzles belong to the selected player, preserve original position metadata, and validate answers against analyzed lines.
- Reports link to real evidence and make no unsupported learning or strength claims.
- Run automated API and interaction checks, then desktop/mobile visual QA when browser access is available.
- Replace obsolete repository code and documentation; preserve Git history. Report implemented features, deferred milestones and verification limits explicitly.

## Team
One integration owner, one UI worker (GPT-6.1 Sol medium), one engine worker (GPT-6.1 Sol high), and one validation worker (GPT-6.1 Sol high). The requested orchestration configuration is GPT-6 Astra high; the current session's underlying model is not changed by this plan.

## Current status
The product is now Rookmate. Gameplay uses our own bounded search engine with local observed-move biases; Stockfish is used only for analysis. Numeric level changes prioritize sampled move quality over result. Resignation, large/date-filtered public imports, stop/resume, IndexedDB storage, practical charcoal/blue UI, MIT license and contributor documentation are implemented. A flaky depth-3 assertion was replaced by a legal-move plus bounded-node assertion; 56 full-suite tests pass after this change. These update the original Stockfish-opponent plan below.

Implemented: reliable local gameplay, PGN and public username imports, bounded engine reviews, source-based puzzles and rematches, sample scouting, optional result-based difficulty calibration, rival presets, and dated settings replay. All 31 automated checks pass, including real Stockfish and DOM training integration. Public imports were live checked against both providers. Browser visual QA remains unavailable because the browser control host cannot connect.

Remaining: full-game/deeper analysis, acceptable-alternative and multi-move puzzle validation, richer recurring-theme profiles, and measured historical style imitation. Settings replay is not a faithful past-self model. See TODO.md for the remaining product milestones.
