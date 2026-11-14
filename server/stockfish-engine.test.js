const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Chess } = require('chess.js');
const { StockfishEngine, selectStyleMove } = require('./stockfish-engine');
const { importPgn } = require('./pgn-import');
const START = new Chess().fen();

test('style preferences use legal candidates within sixty centipawns and preserve mate lines', () => {
  const chess = new Chess();
  chess.move('e4');
  chess.move('d5');
  const candidates = new Map([
    [1, { cp: 100, mate: null, depth: 12, pv: ['g1f3'] }],
    [2, { cp: 70, mate: null, depth: 12, pv: ['e4d5'] }],
    [3, { cp: 0, mate: null, depth: 12, pv: ['f1b5'] }],
  ]);
  assert.equal(selectStyleMove(chess.fen(), 'g1f3', candidates, 'attacking').move, 'e4d5');
  assert.equal(selectStyleMove(chess.fen(), 'g1f3', candidates, 'careful').move, 'g1f3');
  candidates.get(2).cp = 30;
  assert.equal(selectStyleMove(chess.fen(), 'g1f3', candidates, 'attacking'), null);
  candidates.get(1).mate = 2;
  assert.equal(selectStyleMove(chess.fen(), 'g1f3', candidates, 'careful'), null);
});

function fakeSpawner(search) {
  let launches = 0;
  return () => {
    const launch = ++launches;
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.stdin.end();
      proc.stdout.end();
      proc.stderr.end();
      setImmediate(() => proc.emit('exit', 0));
    };
    proc.stdin.on('data', (data) => {
      for (const command of String(data).trim().split('\n')) {
        if (command === 'uci') proc.stdout.write('uciok\n');
        if (command === 'isready') proc.stdout.write('readyok\n');
        if (command.startsWith('go ')) search(proc, launch);
      }
    });
    return proc;
  };
}

test('searches are serialized and scores use the white perspective', async () => {
  let active = 0;
  let maximum = 0;
  const engine = new StockfishEngine({ spawn: fakeSpawner((proc) => {
    active += 1;
    maximum = Math.max(maximum, active);
    setTimeout(() => {
      active -= 1;
      proc.stdout.write('info depth 9 score cp 42 pv e2e4 e7e5\nbestmove e2e4\n');
    }, 5);
  }) });
  try {
    const results = await Promise.all([engine.analyze(START), engine.analyze(START), engine.analyze(START)]);
    assert.equal(maximum, 1);
    assert.equal(results[0].cp, 42);
    assert.deepEqual(results[0].pv, ['e2e4', 'e7e5']);
  } finally { engine.close(); }
  const chess = new Chess();
  chess.move('e4');
  const blackEngine = new StockfishEngine({ spawn: fakeSpawner((proc) => {
    proc.stdout.write('info depth 7 score mate 3 pv e7e5\nbestmove e7e5\n');
  }) });
  try { assert.equal((await blackEngine.analyze(chess.fen())).mate, -3); }
  finally { blackEngine.close(); }
});

test('a timed out engine is discarded and the next request recovers', async () => {
  const engine = new StockfishEngine({ searchTimeout: 20, spawn: fakeSpawner((proc, launch) => {
    if (launch > 1) proc.stdout.write('bestmove e2e4\n');
  }) });
  try {
    await assert.rejects(engine.move(START), /timed out/);
    assert.equal(await engine.move(START), 'e2e4');
  } finally { engine.close(); }
});

test('illegal engine output is rejected and does not poison the queue', async () => {
  const engine = new StockfishEngine({ spawn: fakeSpawner((proc, launch) => {
    proc.stdout.write(`bestmove ${launch === 1 ? 'e2e5' : 'd2d4'}\n`);
  }) });
  try {
    await assert.rejects(engine.move(START), /illegal move/);
    assert.equal(await engine.move(START), 'd2d4');
  } finally { engine.close(); }
});

test('startup timeout is bounded and a later request starts a new process', async () => {
  const successful = fakeSpawner((proc) => proc.stdout.write('bestmove g1f3\n'));
  let first = true;
  const engine = new StockfishEngine({ startTimeout: 20, spawn: () => {
    const proc = successful();
    if (first) {
      first = false;
      proc.stdin.removeAllListeners('data');
    }
    return proc;
  } });
  try {
    await assert.rejects(engine.move(START), /timed out/);
    assert.equal(await engine.move(START), 'g1f3');
  } finally { engine.close(); }
});

test('unexpected process exit rejects current search and later requests recover', async () => {
  const engine = new StockfishEngine({ spawn: fakeSpawner((proc, launch) => {
    if (launch === 1) setImmediate(() => proc.emit('exit', 1));
    else proc.stdout.write('bestmove c2c4\n');
  }) });
  try {
    await assert.rejects(engine.move(START), /exited unexpectedly/);
    assert.equal(await engine.move(START), 'c2c4');
  } finally { engine.close(); }
});

test('queue limit, closed state, FEN, and difficulty validation are bounded', async () => {
  const engine = new StockfishEngine({ maxQueue: 1, spawn: fakeSpawner((proc) => {
    setTimeout(() => proc.stdout.write('bestmove e2e4\n'), 5);
  }) });
  try {
    const first = engine.move(START);
    await assert.rejects(engine.move(START), /busy/);
    await assert.rejects(engine.move('not fen'), /Invalid FEN/);
    await assert.rejects(engine.move(START, 'impossible'), /Invalid difficulty/);
    assert.equal(await first, 'e2e4');
  } finally { engine.close(); }
  await assert.rejects(engine.move(START), /closed/);
});

test('PGN import preserves headers and legal replay positions for multiple games', () => {
  const pgn = '[Event "First"]\n[White "Player"]\n[Black "Rival"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n\n[Event "Second"]\n[Result "*"]\n\n1. d4 d5 *';
  const games = importPgn(pgn);
  assert.equal(games.length, 2);
  assert.equal(games[0].headers.White, 'Player');
  assert.equal(games[0].result, '1-0');
  assert.equal(games[0].moves[0].uci, 'e2e4');
  assert.equal(games[0].moves[0].before, START);
  const replay = new Chess(games[1].initialFen);
  for (const move of games[1].moves) {
    replay.move(move.san);
    assert.equal(replay.fen(), move.fen);
  }
  assert.throws(() => importPgn('1. e4 bananas'), /invalid PGN/);
  assert.throws(() => importPgn(''), /Provide a PGN/);
  assert.throws(() => importPgn(Array.from({ length: 21 }, (_, n) => `[Event "${n}"]\n\n1. e4 *`).join('\n')), /at most 20/);
});
