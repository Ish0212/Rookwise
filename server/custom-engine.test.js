const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { chooseMove, CustomEngine, searchPosition, evaluate } = require('./custom-engine');

function applyUci(chess, move) {
  assert.match(move, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  return chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
}

test('custom evaluation recognizes material and is white-centric', () => {
  const whiteQueen = new Chess('4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1');
  const blackQueen = new Chess('4k3/4q3/8/8/8/8/8/4K3 b - - 0 1');
  assert.ok(evaluate(whiteQueen) > 800);
  assert.ok(evaluate(blackQueen) < -800);
  assert.equal(evaluate(new Chess()), 0);
});

test('custom search takes a free queen and handles promotion', () => {
  const capture = '4k3/8/8/8/8/8/4q3/4R1K1 w - - 0 1';
  for (const seed of [1, 8, 20]) {
    assert.equal(searchPosition(capture, { rating: 800, seed }).move, 'e1e2');
  }
  const promotion = new Chess('8/P6k/8/8/8/8/8/6K1 w - - 0 1');
  const result = searchPosition(promotion.fen(), { rating: 800, seed: 1 });
  assert.equal(result.move, 'a7a8q');
  assert.equal(applyUci(promotion, result.move).promotion, 'q');
});

test('detected mate overrides rating randomness and terminal positions return null', async () => {
  const mateInOne = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
  for (const seed of [1, 21, 900]) {
    const chess = new Chess(mateInOne);
    applyUci(chess, searchPosition(mateInOne, { rating: 100, seed }).move);
    assert.ok(chess.isCheckmate());
  }
  assert.equal(await chooseMove('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1'), null);
  assert.equal(await chooseMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), null);
});

test('rating controls search effort while seeded plausible sampling is repeatable', () => {
  const fen = new Chess().fen();
  const first = searchPosition(fen, { rating: 400, seed: 15 });
  assert.equal(first.move, searchPosition(fen, { rating: 400, seed: 15 }).move);
  assert.equal(first.depth, 1);
  const stronger = searchPosition(fen, { rating: 1000, seed: 15 });
  assert.equal(stronger.depth, 2);
  assert.ok(stronger.nodes > first.nodes);
  const observed = new Set(Array.from({ length: 12 }, (_, n) => searchPosition(fen, { rating: 500, seed: n * 100000 }).move));
  assert.ok(observed.size > 1);
  const sparse = searchPosition('7k/8/8/8/8/8/4P3/4K3 w - - 0 1', { rating: 1900, seed: 1 });
  assert.match(sparse.move, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  assert.ok(sparse.nodes > 0 && sparse.nodes < 250000);
});

test('observed position preferences change sampling without admitting illegal moves or bad blunders', () => {
  const fen = new Chess().fen();
  let baseline = 0;
  let learned = 0;
  for (let index = 0; index < 256; index += 1) {
    const options = { rating: 500, seed: index * 87654321 };
    if (searchPosition(fen, options).move === 'e2e4') baseline += 1;
    const result = searchPosition(fen, { ...options, preferences: { e2e4: 1000, e2e5: 1000 } });
    if (result.move === 'e2e4') learned += 1;
    applyUci(new Chess(), result.move);
  }
  assert.ok(learned > baseline, `Expected learned e4 preference: ${learned} > ${baseline}`);
  const capture = '4k3/8/8/8/8/8/4q3/4R1K1 w - - 0 1';
  assert.equal(searchPosition(capture, { rating: 800, seed: 1, preferences: { g1h1: 1e100 } }).move, 'e1e2');
});

test('observed habits are bounded and optional profile data is sanitized before worker transfer', async () => {
  const engine = new CustomEngine();
  try {
    const chess = new Chess();
    const result = await engine.chooseMove(chess.fen(), {
      rating: 600, seed: 2,
      preferences: { e2e4: Infinity, g1f3: -10, nonsense: 4 },
      habits: { captureRate: 500, checkRate: -10, queenRate: NaN },
    });
    applyUci(chess, result);
  } finally { engine.close(); }
});

test('all style presets produce legal moves across an actual game', async () => {
  const engine = new CustomEngine();
  const chess = new Chess();
  try {
    const styles = ['balanced', 'attacking', 'careful'];
    for (let ply = 0; ply < 10 && !chess.isGameOver(); ply += 1) {
      const move = await engine.chooseMove(chess.fen(), { rating: 650, style: styles[ply % styles.length], seed: ply * 100000 });
      assert.ok(applyUci(chess, move));
    }
    assert.equal(chess.history().length, 10);
  } finally { engine.close(); }
});

test('bounded search runs in a worker while the main event loop stays responsive', async () => {
  const engine = new CustomEngine();
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 10);
  const started = Date.now();
  try {
    const move = await engine.chooseMove(new Chess().fen(), { rating: 1900, seed: 1 });
    applyUci(new Chess(), move);
    assert.ok(ticks >= 2);
    assert.ok(Date.now() - started < 2000);
  } finally { clearInterval(interval); engine.close(); }
});

test('custom engine validates options, bounds queue length, and rejects requests after close', async () => {
  const engine = new CustomEngine();
  const fen = new Chess().fen();
  await assert.rejects(engine.chooseMove('invalid'), /FEN/i);
  await assert.rejects(engine.chooseMove(fen, { rating: 'strong' }), /Rating/);
  await assert.rejects(engine.chooseMove(fen, { style: 'unknown' }), /style/);
  const pending = Array.from({ length: 8 }, () => engine.chooseMove(fen, { rating: 1900 }));
  const settled = Promise.allSettled(pending);
  await assert.rejects(engine.chooseMove(fen), /busy/);
  engine.close();
  await settled;
  await assert.rejects(engine.chooseMove(fen), /closed/);
});
