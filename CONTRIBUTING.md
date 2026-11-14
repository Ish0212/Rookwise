# Contributing to Rookwise

Install root and server dependencies, run npm start and npm test. Node 22+ is required; there is no frontend build step.

Keep changes focused. Add regressions for game state, engine behavior, import pagination and calibration. Preserve saved-data compatibility or document migration. Do not commit player histories, credentials, dependencies or caches.

For engine work, distinguish tactical strength, human-move similarity and adaptation. Report evidence separately. Seed sampling tests. Do not call the practice scale measured Elo without external calibration.

Check desktop/mobile layout, keyboard focus, promotion, restart during thinking and reload. Include screenshots when browser tools are available.

Report bugs with reproduction steps, Node version and relevant errors. Do not include private game histories unless deliberately shared. Pull requests should explain the change, tests and limitations.

Original code contributions use MIT. Preserve third-party notices.
