const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { Chess } = require('../server/node_modules/chess.js');

const root = path.resolve(__dirname, '..');
const key = 'chessai.session.v1';
const tick = () => new Promise(resolve => setImmediate(resolve));

function session(moves = [], options = {}) {
  const chess = new Chess(options.fen);
  for (const move of moves) chess.move(move);
  return { pgn: chess.pgn(), playerColor: 'w', difficulty: 'medium', orientation: 'w', ...options };
}

async function browser(t, saved, extraStorage = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'http://localhost:3001', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  t.after(() => window.close());
  window.Chess = Chess;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const downloads = [];
  window.URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:test'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.at(-1).filename = this.download; };
  if (saved !== undefined) window.localStorage.setItem(key, typeof saved === 'string' ? saved : JSON.stringify(saved));
  for (const [name, value] of Object.entries(extraStorage)) window.localStorage.setItem(name, value);
  const requests = [];
  window.fetch = (url, options) => new Promise((resolve, reject) => {
    requests.push({ url, options, body: JSON.parse(options.body), reject,
      respond: (body, ok = true) => resolve({ ok, json: async () => body }) });
  });
  const modules = new Map();
  function getModule(file) {
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), {
      context: dom.getInternalVMContext(), identifier: file,
      importModuleDynamically: async (specifier, importer) => {
        const child = link(specifier, importer);
        if (child.status === 'unlinked') await child.link(link);
        await child.evaluate();
        return child;
      },
    }));
    return modules.get(file);
  }
  const link = (specifier, importer) => getModule(specifier === '/vendor/chess.js'
    ? path.join(root, 'server/node_modules/chess.js/dist/esm/chess.js')
    : path.resolve(path.dirname(importer.identifier), specifier));
  const main = getModule(path.join(root, 'app.js'));
  await main.link(link);
  await main.evaluate();
  await tick();
  const $ = selector => window.document.querySelector(selector);
  return { window, requests, downloads, modules, $, click: selector => { assert.ok($(selector), selector); $(selector).click(); },
    saved: () => JSON.parse(window.localStorage.getItem(key)) };
}

function play(app, from, to) { app.click(`[data-square="${from}"]`); app.click(`[data-square="${to}"]`); }
function savedChess(app) { const chess = new Chess(); chess.loadPgn(app.saved().pgn); return chess; }

test('legal selection, illegal moves, engine reply, replay, and takeback work together', async t => {
  const app = await browser(t);
  assert.equal(app.window.document.querySelectorAll('[data-square]').length, 64);
  app.click('[data-square="e2"]');
  assert.equal(app.$('[data-square="e4"]').classList.contains('legal'), true);
  app.click('[data-square="e5"]');
  assert.equal(app.requests.length, 0);
  play(app, 'e2', 'e4');
  assert.equal(app.requests.length, 1);
  assert.equal(new Chess(app.requests[0].body.fen).turn(), 'b');
  play(app, 'd2', 'd4');
  assert.equal(app.requests.length, 1, 'human cannot move while engine is pending');
  app.requests[0].respond({ move: 'e7e5' });
  await tick();
  assert.deepEqual(savedChess(app).history(), ['e4', 'e5']);
  app.click('#first');
  assert.match(app.$('#status').textContent, /Looking back/);
  assert.match(app.$('[data-square="e2"]').getAttribute('aria-label'), /white pawn/);
  play(app, 'd2', 'd4');
  assert.deepEqual(savedChess(app).history(), ['e4', 'e5']);
  app.click('#return-live');
  assert.match(app.$('[data-square="e4"]').getAttribute('aria-label'), /white pawn/);
  app.click('#takeback');
  assert.deepEqual(savedChess(app).history(), []);
});

test('reload preserves the exact game and orientation; engine-turn sessions resume', async t => {
  const saved = session(['e4', 'e5', 'Nf3', 'Nc6'], { orientation: 'b', difficulty: 'hard' });
  const app = await browser(t, saved);
  assert.deepEqual(savedChess(app).history(), ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.equal(app.$('[data-square]').dataset.square, 'h1');
  assert.equal(app.requests.length, 0);
  const pending = await browser(t, session(['d4']));
  assert.equal(pending.requests.length, 1);
  pending.requests[0].respond({ move: 'd7d5' });
  await tick();
  assert.deepEqual(savedChess(pending).history(), ['d4', 'd5']);
});

test('new black game starts with an AI move and ignores an old in-flight response', async t => {
  const app = await browser(t);
  play(app, 'e2', 'e4');
  const obsolete = app.requests[0];
  app.click('#new-game');
  app.$('[name="color"][value="b"]').checked = true;
  app.$('[name="difficulty"][value="easy"]').checked = true;
  app.$('#setup-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(obsolete.options.signal.aborted, true);
  assert.equal(app.requests.length, 2);
  obsolete.respond({ move: 'e7e5' });
  await tick();
  assert.deepEqual(savedChess(app).history(), []);
  app.requests[1].respond({ move: 'd2d4' });
  await tick();
  assert.equal(app.saved().playerColor, 'b');
  assert.equal(app.saved().difficulty, 'easy');
  assert.equal(app.$('[data-square]').dataset.square, 'h1');
  play(app, 'd7', 'd5');
  assert.deepEqual(savedChess(app).history(), ['d4', 'd5']);
});

test('engine failure and illegal output keep the position safe and allow retry', async t => {
  const app = await browser(t);
  play(app, 'e2', 'e4');
  const fen = app.requests[0].body.fen;
  app.requests[0].respond({ error: 'Temporarily unavailable' }, false);
  await tick();
  assert.equal(app.$('#error').hidden, false);
  assert.deepEqual(savedChess(app).history(), ['e4']);
  app.click('#retry');
  assert.equal(app.requests[1].body.fen, fen);
  app.requests[1].respond({ move: 'a1a8' });
  await tick();
  assert.match(app.$('#error-text').textContent, /illegal/);
  assert.deepEqual(savedChess(app).history(), ['e4']);
  app.click('#retry');
  app.requests[2].respond({ move: 'c7c5' });
  await tick();
  assert.equal(app.$('#error').hidden, true);
  assert.deepEqual(savedChess(app).history(), ['e4', 'c5']);
});

test('castling, en passant, and promotion are playable through the board', async t => {
  const castle = await browser(t, session(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']));
  play(castle, 'e1', 'g1');
  assert.equal(savedChess(castle).get('f1').type, 'r');
  assert.equal(savedChess(castle).history().at(-1), 'O-O');
  const ep = await browser(t, session(['e4', 'a6', 'e5', 'd5']));
  play(ep, 'e5', 'd6');
  assert.equal(savedChess(ep).get('d5'), undefined);
  assert.equal(savedChess(ep).get('d6').color, 'w');
  const promotion = await browser(t, session([], { fen: '8/P7/8/8/8/7k/8/7K w - - 0 1' }));
  play(promotion, 'a7', 'a8');
  assert.equal(promotion.$('#promotion-dialog').open, true);
  promotion.click('[data-promotion="n"]');
  assert.equal(savedChess(promotion).get('a8').type, 'n');
  assert.equal(promotion.$('#promotion-dialog').open, false);
});

test('terminal games display their result and never request another engine move', async t => {
  const fixtures = [
    [session(['f3', 'e5', 'g4', 'Qh4#']), /checkmate/],
    [session([], { fen: '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1', playerColor: 'b' }), /stalemate/],
    [session([], { fen: '7k/8/8/8/8/8/8/K7 w - - 0 1' }), /insufficient/],
    [session(['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8']), /repetition/],
    [session([], { fen: '7k/8/8/8/8/8/8/KR6 w - - 100 51' }), /fifty-move/],
  ];
  for (const [saved, expected] of fixtures) {
    const app = await browser(t, saved);
    assert.equal(app.requests.length, 0);
    assert.equal(app.$('#game-label').textContent, 'GAME COMPLETE');
    assert.match(app.$('#status-detail').textContent, expected);
  }
});

test('corrupt storage falls back to a playable fresh board', async t => {
  const app = await browser(t, '{bad-json');
  assert.deepEqual(savedChess(app).history(), []);
  play(app, 'e2', 'e4');
  assert.equal(app.requests.length, 1);
});

test('PGN export downloads a replayable game with player and result headers', async t => {
  const app = await browser(t, session(['f3', 'e5', 'g4', 'Qh4#']));
  app.click('#export');
  assert.equal(app.downloads.length, 1);
  assert.match(app.downloads[0].filename, /^chess-ai-.*\.pgn$/);
  const text = await new Promise((resolve, reject) => {
    const reader = new app.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(app.downloads[0].blob);
  });
  const chess = new Chess();
  chess.loadPgn(text);
  assert.equal(chess.isCheckmate(), true);
  assert.equal(chess.getHeaders().White, 'You');
  assert.equal(chess.getHeaders().Result, '0-1');
});

test('import, evidence-based puzzle, solve, rematch, and persistent training form one loop', async t => {
  const { importPgn } = require('../server/pgn-import');
  const app = await browser(t);
  assert.ok(app.$('#training'));
  const pgn = '[Event "My game"]\n[White "Alice"]\n[Black "Bob"]\n\n1. f3 e5 *';
  app.$('#pgn-input').value = pgn;
  app.click('#import-pgn');
  assert.equal(app.requests[0].url, '/api/import');
  app.requests[0].respond({ games: importPgn(pgn) });
  await tick();
  app.click('#analyze-game');
  assert.equal(app.requests[1].url, '/api/analyze');
  app.requests[1].respond({ move: 'e2e4', cp: 30, mate: null, depth: 12, pv: ['e2e4'] });
  await tick();
  app.requests[2].respond({ move: 'e7e5', cp: -150, mate: null, depth: 12, pv: ['e7e5'] });
  await tick();
  assert.match(app.$('#training-message').textContent, /Review complete/);
  const training = JSON.parse(app.window.localStorage.getItem('chessai.training.v1'));
  assert.equal(training.puzzles.length, 1);
  assert.equal(training.puzzles[0].loss, 180);
  assert.equal(training.puzzles[0].played, 'f3');
  assert.equal(training.puzzles[0].label, 'Alice vs Bob');
  app.click('[data-puzzle-square="d2"]'); app.click('[data-puzzle-square="d4"]');
  assert.match(app.$('#puzzle-feedback').textContent, /another look/);
  app.click('[data-puzzle-square="e2"]'); app.click('[data-puzzle-square="e4"]');
  assert.match(app.$('#puzzle-feedback').textContent, /Found it/);
  assert.match(app.$('#puzzle-evidence').textContent, /you played f3/);
  app.click('#run-it-back');
  assert.equal(savedChess(app).fen(), training.puzzles[0].fen);
  const reloaded = await browser(t, app.saved(), { 'chessai.training.v1': app.window.localStorage.getItem('chessai.training.v1') });
  assert.equal(reloaded.$('#puzzle-content').hidden, false);
  assert.match(reloaded.$('#training-message').textContent, /restored/);
  reloaded.click('#analyze-game');
  assert.equal(reloaded.requests.length, 0);
  assert.match(reloaded.$('#training-message').textContent, /already been reviewed/);
});

test('adaptive settings calibrate only completed unique standard games and preserve earlier settings', async t => {
  const app = await browser(t);
  const profile = app.modules.get(path.join(root, 'personal.js')).namespace;
  assert.equal(profile.chooseDifficulty('easy'), 'easy');
  app.$('#partner-adaptive').checked = true;
  app.$('#partner-adaptive').dispatchEvent(new app.window.Event('change'));
  assert.equal(profile.chooseDifficulty('easy'), 'medium');
  app.$('#partner-style').value = 'attacking';
  app.$('#partner-style').dispatchEvent(new app.window.Event('change'));
  const games = [['a3', 'a6'], ['h3', 'h6'], ['b3', 'b6']].map(prefix => {
    const chess = new Chess();
    for (const san of [...prefix, 'e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) chess.move(san);
    return { pgn: chess.pgn(), playerColor: 'w', difficulty: 'medium' };
  });
  for (const game of games) profile.recordCompletedGame(game);
  assert.equal(profile.chooseDifficulty('easy'), 'hard');
  profile.recordCompletedGame(games[2]);
  const shortGame = session(['f3', 'e5', 'g4', 'Qh4#']);
  profile.recordCompletedGame(shortGame);
  const rematch = new Chess(); rematch.loadPgn(games[0].pgn);
  rematch.header('SetUp', '1', 'FEN', new Chess().fen());
  profile.recordCompletedGame({ ...games[0], pgn: rematch.pgn() });
  let saved = JSON.parse(app.window.localStorage.getItem('chessai.partner.v1'));
  assert.equal(saved.results.length, 3);
  assert.equal(saved.snapshots.length, 3);
  app.$('#partner-style').value = 'careful';
  app.$('#partner-style').dispatchEvent(new app.window.Event('change'));
  app.$('#partner-past').value = saved.snapshots[0].id;
  app.$('#partner-past').dispatchEvent(new app.window.Event('change'));
  assert.equal(profile.chooseDifficulty('easy'), 'medium');
  assert.equal(profile.engineOptions().style, 'attacking');
  saved = app.window.localStorage.getItem('chessai.partner.v1');
  const reloaded = await browser(t, undefined, { 'chessai.partner.v1': saved });
  const restored = reloaded.modules.get(path.join(root, 'personal.js')).namespace;
  assert.equal(restored.chooseDifficulty('hard'), 'medium');
  assert.equal(restored.engineOptions().style, 'attacking');
});
