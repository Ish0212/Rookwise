const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Chess } = require('../server/node_modules/chess.js');

async function loadProfile(saved) {
  const storage = new Map(saved ? [['chessai.partner.v1', JSON.stringify(saved)]] : []);
  const context = vm.createContext({
    localStorage: { getItem: name => storage.get(name) || null, setItem: (name, value) => storage.set(name, value) },
    document: { getElementById: () => null },
  });
  const chess = new vm.SyntheticModule(['Chess'], function () { this.setExport('Chess', Chess); }, { context });
  const profile = new vm.SourceTextModule(fs.readFileSync(path.join(__dirname, '../personal.js'), 'utf8'), { context });
  await profile.link(() => chess);
  await profile.evaluate();
  return { api: profile.namespace, saved: () => JSON.parse(storage.get('chessai.partner.v1') || 'null') };
}

const quality = (meanLossCp, medianLossCp, samples = 12, totalMoves = 12) => ({ meanLossCp, medianLossCp, samples, totalMoves });

test('move quality dominates outcomes: a strong loss can improve and a poor win can decline', async () => {
  const { api: { calibrate } } = await loadProfile();
  const strongLoss = calibrate({ rating: 800, score: 0, analysis: quality(20, 15) });
  const weakWin = calibrate({ rating: 800, score: 1, analysis: quality(220, 180) });
  assert.ok(strongLoss.delta > 0, JSON.stringify(strongLoss));
  assert.ok(weakWin.delta < 0, JSON.stringify(weakWin));
  const strongWin = calibrate({ rating: 800, score: 1, analysis: quality(20, 15) });
  assert.ok(strongWin.delta >= strongLoss.delta);
  assert.match(strongLoss.reason, /Move quality led/);
});

test('one isolated blunder has bounded influence when most analyzed moves were strong', async () => {
  const { api: { calibrate } } = await loadProfile();
  const clean = calibrate({ rating: 800, score: 0, analysis: quality(20, 20) });
  const oneBlunder = calibrate({ rating: 800, score: 0, analysis: quality(180, 20) });
  const uniformlyPoor = calibrate({ rating: 800, score: 0, analysis: quality(180, 180) });
  assert.ok(oneBlunder.delta > 0);
  assert.ok(oneBlunder.delta >= clean.delta - 35);
  assert.ok(oneBlunder.delta > uniformlyPoor.delta);
  assert.equal(oneBlunder.robustLossCp, 40);
});

test('one analyzed move cannot inflate the estimate and small coverage dampens change', async () => {
  const { api: { calibrate } } = await loadProfile();
  const single = calibrate({ rating: 800, score: 1, analysis: quality(0, 0, 1, 30) });
  const limited = calibrate({ rating: 800, score: 1, analysis: quality(10, 10, 3, 30) });
  const complete = calibrate({ rating: 800, score: 1, analysis: quality(10, 10, 12, 12) });
  assert.equal(single.delta, 0);
  assert.equal(single.confidence, 0);
  assert.ok(limited.delta < complete.delta);
  assert.ok(limited.confidence < .1);
  assert.equal(calibrate({ rating: 800, score: 1 }).delta, 0);
});

test('numeric calibration bounds and malformed analysis stay finite', async () => {
  const { api: { calibrate } } = await loadProfile();
  for (const rating of [400, 2200, NaN, -100, 9999]) {
    for (const analysis of [quality(0, 0), quality(1000, 1000), quality(NaN, 0), quality(0, 0, 0, 0)]) {
      const result = calibrate({ rating, score: 0, analysis });
      assert.ok(Number.isFinite(result.rating));
      assert.ok(result.rating >= 400 && result.rating <= 2200);
      assert.ok(Math.abs(result.delta) <= 90);
    }
  }
});

test('resigned games use quality, dedupe results, and exclude short games and position rematches', async () => {
  const profile = await loadProfile();
  const chess = new Chess();
  for (const move of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Bc5']) chess.move(move);
  const input = { pgn: chess.pgn(), playerColor: 'w', difficulty: 'medium', resigned: true, analysis: quality(10, 10, 4, 4) };
  const change = profile.api.recordCompletedGame(input);
  assert.ok(change.delta > 0);
  assert.ok(profile.api.engineOptions().rating > 800);
  assert.equal(profile.api.recordCompletedGame(input), null);
  assert.equal(profile.saved().results.length, 1);
  const short = new Chess(); short.move('e4');
  assert.equal(profile.api.recordCompletedGame({ ...input, pgn: short.pgn() }), null);
  chess.header('SetUp', '1', 'FEN', new Chess().fen());
  assert.equal(profile.api.recordCompletedGame({ ...input, pgn: chess.pgn() }), null);
  assert.equal(profile.saved().results.length, 1);
  assert.match(profile.api.describePartner(), /Practice estimate/);
});

test('legacy snapshots migrate to numeric settings and keep the selected rival style', async () => {
  const profile = await loadProfile({ adaptive: true, style: 'careful', results: [],
    snapshots: [{ id: 'old', difficulty: 'hard', style: 'attacking', date: '2026-01-01' }], past: 'old' });
  assert.equal(profile.api.engineOptions().rating, 1600);
  assert.equal(profile.api.engineOptions().style, 'attacking');
  assert.equal(profile.api.chooseDifficulty('easy'), 'hard');
});

test('manual practice level validates, rounds, clamps, persists, and exits past settings', async () => {
  const profile = await loadProfile({ adaptive: true, rating: 800, style: 'careful', results: [],
    snapshots: [{ id: 'old', rating: 1600, style: 'attacking', date: '2026-01-01' }], past: 'old' });
  assert.equal(profile.api.setPracticeRating('1200.6'), 1201);
  assert.equal(profile.api.engineOptions().rating, 1201);
  assert.equal(profile.api.engineOptions().style, 'careful');
  assert.equal(profile.saved().past, '');
  assert.equal(profile.saved().adaptive, true);
  assert.equal(profile.api.setPracticeRating(-20), 400);
  assert.equal(profile.api.setPracticeRating(9999), 2200);
  for (const invalid of ['', '  ', 'bad', null, undefined, true, {}, NaN, Infinity]) {
    assert.equal(profile.api.setPracticeRating(invalid), false);
    assert.equal(profile.api.engineOptions().rating, 2200);
  }
  const restored = await loadProfile(profile.saved());
  assert.equal(restored.api.engineOptions().rating, 2200);
  assert.match(restored.saved().lastChange.reason, /manually/);
});

test('mounted numeric input applies its bounds and restores invalid entries', async t => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<main><footer></footer></main>', { url: 'http://localhost:3001', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const context = dom.getInternalVMContext();
  const chess = new vm.SyntheticModule(['Chess'], function () { this.setExport('Chess', Chess); }, { context });
  const profile = new vm.SourceTextModule(fs.readFileSync(path.join(__dirname, '../personal.js'), 'utf8'), { context });
  await profile.link(() => chess);
  await profile.evaluate();
  profile.namespace.mountPersonal();
  const input = dom.window.document.getElementById('partner-rating');
  assert.equal(input.type, 'number');
  assert.equal(input.min, '400');
  assert.equal(input.max, '2200');
  assert.equal(input.value, '800');
  for (const [entered, expected] of [['100', '400'], ['9000', '2200'], ['', '2200'], ['1050', '1050']]) {
    input.value = entered;
    input.dispatchEvent(new dom.window.Event('change'));
    assert.equal(input.value, expected);
    assert.equal(profile.namespace.engineOptions().rating, Number(expected));
  }
});
