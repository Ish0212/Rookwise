const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Chess } = require('../server/node_modules/chess.js');
const { createApp } = require('../server/server');
const { StockfishEngine } = require('../server/stockfish-engine');

async function serve(t, engine) {
  const server = createApp({ engine }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    engine.close?.();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (route, body, options = {}) => fetch(base + route, body === undefined ? options : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...options,
  });
}

test('move API passes valid FEN and default difficulty to the engine', async t => {
  const calls = [];
  const request = await serve(t, { move: async (...args) => { calls.push(args); return 'e2e4'; } });
  const fen = new Chess().fen();
  const response = await request('/api/move', { fen });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { move: 'e2e4' });
  assert.deepEqual(calls, [[fen, 'medium', 'balanced']]);
});

test('invalid inputs and malformed/oversized bodies never reach the engine', async t => {
  let calls = 0;
  const request = await serve(t, { move: async () => { calls++; return 'e2e4'; } });
  for (const body of [{}, { fen: 'bad fen' }, { fen: new Chess().fen() + '\ngo infinite' },
    { fen: new Chess().fen(), difficulty: 'impossible' }, { fen: new Chess().fen(), difficulty: {} },
    { fen: 123 }, null, []]) {
    const response = await request('/api/move', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const malformed = await request('/api/move', {}, { body: '{' });
  assert.equal(malformed.status, 400);
  const oversized = await request('/api/move', { fen: 'x'.repeat(9000) });
  assert.equal(oversized.status, 413);
  assert.equal(calls, 0);
});

test('engine failure is recoverable and does not reveal internal details', async t => {
  let calls = 0;
  const request = await serve(t, { move: async () => {
    if (!calls++) throw new Error('private engine implementation detail');
    return 'e2e4';
  } });
  const failed = await request('/api/move', { fen: new Chess().fen() });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(await failed.json()), /private engine/);
  assert.equal((await request('/api/move', { fen: new Chess().fen() })).status, 200);
});

test('public assets are local and server/source files stay private', async t => {
  const request = await serve(t, { move: async () => null });
  for (const route of ['/', '/index.html', '/styles.css', '/app.js', '/training.js', '/personal.js', '/vendor/chess.js']) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 0);
  }
  for (const route of ['/.git/config', '/server/server.js', '/package.json', '/node_modules/jsdom/package.json', '/README.md', '/api/games']) {
    assert.equal((await request(route)).status, 404, route);
  }
});

test('PGN import preserves legal move evidence and rejects invalid or excessive data', async t => {
  const request = await serve(t, { move: async () => null });
  const pgn = '[Event "Practice"]\n[White "Alice"]\n[Black "Bob"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
  const response = await request('/api/import', { pgn });
  assert.equal(response.status, 200);
  const { games } = await response.json();
  assert.equal(games.length, 1);
  assert.equal(games[0].headers.White, 'Alice');
  assert.equal(games[0].result, '0-1');
  const replay = new Chess(games[0].initialFen);
  for (const move of games[0].moves) {
    assert.equal(move.before, replay.fen());
    const played = replay.move(move.san);
    assert.equal(move.uci, played.from + played.to + (played.promotion || ''));
    assert.equal(move.fen, replay.fen());
  }
  assert.equal(replay.fen(), games[0].finalFen);
  assert.equal(replay.isCheckmate(), true);
  for (const body of [{}, { pgn: '' }, { pgn: '1. e4 impossible' }, { pgn: 'x'.repeat(750001) },
    { pgn: Array(21).fill(pgn).join('\n\n') }]) {
    assert.equal((await request('/api/import', body)).status, 400);
  }
});

test('analysis API validates FEN and returns white-centric engine evidence', async t => {
  const calls = [];
  const expected = { move: 'e2e4', cp: 27, mate: null, pv: ['e2e4', 'e7e5'], depth: 12 };
  const request = await serve(t, { analyze: async (...args) => { calls.push(args); return expected; } });
  const fen = new Chess().fen();
  const response = await request('/api/analyze', { fen });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(calls[0][0], fen);
  assert.equal(calls[0][1], 'hard');
  for (const bad of [{}, { fen: 'invalid' }, { fen: fen + '\nquit' }]) {
    assert.equal((await request('/api/analyze', bad)).status, 400);
  }
  assert.equal(calls.length, 1);
});

test('real Stockfish serves legal moves across turns and terminal positions', { timeout: 30000 }, async t => {
  const engine = new StockfishEngine();
  const request = await serve(t, engine);
  const chess = new Chess();
  for (let ply = 0; ply < 4; ply++) {
    const response = await request('/api/move', { fen: chess.fen(), difficulty: 'easy' });
    assert.equal(response.status, 200);
    const { move } = await response.json();
    assert.match(move, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
    assert.ok(chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }));
  }
  const mate = new Chess();
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) mate.move(san);
  assert.equal(mate.isCheckmate(), true);
  const terminal = await request('/api/move', { fen: mate.fen(), difficulty: 'hard' });
  assert.deepEqual(await terminal.json(), { move: null });
});
