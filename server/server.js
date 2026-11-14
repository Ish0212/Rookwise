const express = require('express');
const path = require('node:path');
const { Chess } = require('chess.js');
const { StockfishEngine, LEVELS, STYLES } = require('./stockfish-engine');
const { CustomEngine } = require('./custom-engine');
const { importPgn } = require('./pgn-import');
const { PublicImporter } = require('./public-import');

function createApp({ engine = new CustomEngine(), analyzer = engine.analyze ? engine : new StockfishEngine(), importer = new PublicImporter() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.engine = engine;
  app.locals.analyzer = analyzer;
  const gameJson = express.json({ limit: '1mb', strict: true });
  const moveJson = express.json({ limit: '8kb', strict: true });
  app.use((req, res, next) => (req.path === '/api/import' ? gameJson : moveJson)(req, res, next));

  app.post('/api/move', async (req, res) => {
    const { fen, difficulty = 'medium', style = 'balanced', rating, preferences, habits } = req.body || {};
    if (typeof fen !== 'string' || fen.length > 200 || /[\r\n]/.test(fen)) {
      return res.status(400).json({ error: 'A valid FEN position is required' });
    }
    try { new Chess(fen); } catch { return res.status(400).json({ error: 'Invalid FEN position' }); }
    if (typeof difficulty !== 'string' || !Object.hasOwn(LEVELS, difficulty)) {
      return res.status(400).json({ error: 'Difficulty must be easy, medium, or hard' });
    }
    if (!STYLES.includes(style)) return res.status(400).json({ error: 'Style must be balanced, attacking, or careful' });
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 400 || rating > 2200)) return res.status(400).json({ error: 'Practice level must be an integer from 400 to 2200' });
    try {
      const move = engine.chooseMove
        ? await engine.chooseMove(fen, { rating: rating ?? ({ easy: 500, medium: 800, hard: 1600 })[difficulty], style, preferences, habits })
        : await engine.move(fen, difficulty, style);
      res.json({ move });
    } catch (error) {
      console.error('Move request failed:', error.message);
      res.status(503).json({ error: 'The chess engine is unavailable. Please try again.' });
    }
  });

  app.post('/api/analyze', async (req, res) => {
    const { fen } = req.body || {};
    if (typeof fen !== 'string' || fen.length > 200 || /[\r\n]/.test(fen)) return res.status(400).json({ error: 'A valid FEN position is required' });
    try { new Chess(fen); } catch { return res.status(400).json({ error: 'Invalid FEN position' }); }
    try {
      res.json(await analyzer.analyze(fen, 'hard', { time: 450 }));
    } catch (error) {
      console.error('Analysis request failed:', error.message);
      res.status(503).json({ error: 'The chess engine is unavailable. Please try again.' });
    }
  });

  app.post('/api/import', (req, res) => {
    try { res.json({ games: importPgn(req.body && req.body.pgn) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.post('/api/import/username', async (req, res) => {
    try { res.json(await importer.import(req.body || {})); }
    catch (error) {
      if (error.status === 429) res.set('Retry-After', '60');
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  const root = path.resolve(__dirname, '..');
  // Only public game assets are served; source, dependencies, and .git stay private.
  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(root, 'index.html')));
  for (const asset of ['app.js', 'styles.css', 'training.js', 'personal.js', 'pieces.js', 'memory.js']) {
    app.get('/' + asset, (req, res) => res.sendFile(path.join(root, asset)));
  }
  app.get('/vendor/chess.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/chess.js/dist/esm/chess.js')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'Request is too large' : 'Invalid request body' });
  });
  return app;
}

function startServer({ port = process.env.PORT || 3001, host = process.env.HOST || '127.0.0.1', engine = new CustomEngine() } = {}) {
  const app = createApp({ engine });
  const server = app.listen(port, host, () => {
    console.log(`Rookmate running at http://${host}:${server.address().port}`);
  });
  server.on('close', () => { engine.close(); app.locals.analyzer.close(); });
  return { app, server, engine };
}

if (require.main === module) {
  const { server, engine, app } = startServer();
  const shutdown = () => {
    engine.close();
    app.locals.analyzer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, startServer };
