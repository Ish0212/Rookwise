import { Chess } from '/vendor/chess.js';

const KEY = 'chessai.partner.v1';
const MIN_RATING = 400;
const MAX_RATING = 2200;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const ratingValue = value => Math.round(clamp(validNumber(value) ? value : 800, MIN_RATING, MAX_RATING));
const legacyRating = difficulty => ({ easy: 600, medium: 1000, hard: 1600 })[difficulty] || 800;
const difficultyFor = rating => rating < 700 ? 'easy' : rating < 1400 ? 'medium' : 'hard';

/* This is a transparent practice heuristic, not a fitted or certified Elo model.
   The median protects a good game from one disastrous move; the capped mean
   still accounts for that move. The result is deliberately a smaller signal. */
export function calibrate({ rating = 800, score = .5, analysis } = {}) {
  const current = ratingValue(rating);
  const result = validNumber(score) ? clamp(score, 0, 1) : .5;
  const valid = analysis && validNumber(analysis.meanLossCp) && analysis.meanLossCp >= 0 &&
    validNumber(analysis.medianLossCp) && analysis.medianLossCp >= 0 &&
    validNumber(analysis.samples) && validNumber(analysis.totalMoves) && analysis.totalMoves > 0;
  const samples = valid ? Math.max(0, Math.floor(analysis.samples)) : 0;
  if (samples < 3) {
    // One measured move, or no analysis, cannot establish strong play.
    const delta = Math.min(0, Math.round((result - .5) * 4));
    const next = ratingValue(current + delta);
    return { rating: next, delta: next - current, confidence: 0, samples,
      reason: samples ? 'Too few analyzed moves to raise the estimate; play quality needs a larger sample.' :
        'Move-quality analysis was unavailable; only a small result adjustment was applied.' };
  }
  const coverage = clamp(samples / analysis.totalMoves, 0, 1);
  const confidence = clamp(samples / 12, 0, 1) * Math.sqrt(coverage);
  const median = Math.min(1000, analysis.medianLossCp);
  const cappedMean = Math.min(1000, analysis.meanLossCp, median + 80);
  const robustLossCp = .75 * median + .25 * cappedMean;
  // The scale maps lower measured loss to a stronger practice target. It has
  // not been calibrated against rated populations and must not be called Elo.
  const performance = clamp(2200 - 500 * Math.log2(1 + robustLossCp / 15), MIN_RATING, MAX_RATING);
  const qualityChange = (performance - current) * .18;
  const resultChange = (result - .5) * 24;
  const requested = Math.round(clamp(qualityChange + resultChange, -90, 90) * confidence);
  const next = ratingValue(current + requested);
  const delta = next - current;
  const outcome = result === 1 ? 'win' : result === 0 ? 'loss' : 'draw';
  return { rating: next, delta, confidence, samples, robustLossCp, performance: Math.round(performance),
    reason: `${samples} of ${Math.floor(analysis.totalMoves)} moves analyzed; median loss ${Math.round(median)} cp, robust loss ${Math.round(robustLossCp)} cp. Move quality led the adjustment; the ${outcome} had a smaller influence. ${confidence < .5 ? 'Limited coverage kept the change small.' : 'This remains a practice estimate.'}` };
}

let state = { adaptive: true, style: 'balanced', rating: 800, results: [], snapshots: [], past: '', lastChange: null };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved && Array.isArray(saved.results) && Array.isArray(saved.snapshots)) {
    state = { ...state, ...saved };
    state.adaptive = typeof saved.adaptive === 'boolean' ? saved.adaptive : true;
    state.rating = ratingValue(saved.rating);
    state.style = ['balanced', 'attacking', 'careful'].includes(state.style) ? state.style : 'balanced';
    state.results = state.results.slice(-100);
    state.snapshots = state.snapshots.slice(-20).filter(item => item && typeof item.id === 'string')
      .map(item => ({ ...item, rating: ratingValue(validNumber(item.rating) ? item.rating : legacyRating(item.difficulty)) }));
    if (!state.snapshots.some(item => item.id === state.past)) state.past = '';
  }
} catch { /* Optional profile corruption must not block chess. */ }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { document.getElementById('partner-note')?.append(' Profile storage is unavailable.'); }
}
function snapshot() { return state.snapshots.find(item => item.id === state.past); }
export function chooseDifficulty(requested) {
  const prior = snapshot();
  return prior ? difficultyFor(prior.rating) : state.adaptive ? difficultyFor(state.rating) : requested;
}
export function engineOptions() { return { rating: snapshot()?.rating || state.rating, style: snapshot()?.style || state.style }; }
export function setPracticeRating(value) {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!validNumber(numeric)) return false;
  const next = ratingValue(numeric);
  if (next !== state.rating) state.lastChange = { rating: next, delta: next - state.rating,
    reason: 'Practice level set manually. Future analyzed games can refine it when automatic adjustment is enabled.' };
  state.rating = next;
  state.past = '';
  save(); refresh();
  return next;
}
export function describePartner() {
  return `${snapshot() ? 'Past practice settings' : 'Practice estimate'} · ${engineOptions().rating}`;
}
export function recordCompletedGame({ pgn, playerColor, difficulty, resigned = false, analysis } = {}) {
  if (!['w', 'b'].includes(playerColor)) return null;
  const game = new Chess();
  try { game.loadPgn(pgn); } catch { return null; }
  const moves = game.history();
  if ((!game.isGameOver() && !resigned) || game.getHeaders().SetUp === '1' || moves.length < 8 || state.past) return null;
  const identity = playerColor + ':' + moves.join(' ');
  if (state.results.some(item => item.identity === identity)) return null;
  const score = resigned ? 0 : game.isDraw() ? .5 : game.turn() === playerColor ? 0 : 1;
  const playedRating = state.rating;
  const change = calibrate({ rating: playedRating, score, analysis });
  const date = new Date().toISOString();
  state.results.push({ identity, score, rating: playedRating, difficulty, date,
    analysis: analysis ? { meanLossCp: analysis.meanLossCp, medianLossCp: analysis.medianLossCp,
      samples: analysis.samples, totalMoves: analysis.totalMoves } : null,
    delta: state.adaptive ? change.delta : 0 });
  state.results = state.results.slice(-100);
  if (state.adaptive) {
    state.rating = change.rating;
    state.lastChange = { ...change, date };
  } else {
    state.lastChange = { ...change, rating: state.rating, delta: 0, date,
      reason: 'Automatic adjustment is paused. Your estimate stayed the same.' };
  }
  state.snapshots.push({ id: `${Date.now()}-${state.results.length}`, date, rating: playedRating,
    difficulty: difficultyFor(playedRating), style: state.style });
  state.snapshots = state.snapshots.slice(-20);
  save(); refresh();
  return state.lastChange;
}
function refresh() {
  const count = document.getElementById('partner-progress');
  if (!count) return;
  document.getElementById('partner-rating').value = String(engineOptions().rating);
  count.textContent = `Practice estimate: ${state.rating} · ${state.results.length} completed games recorded. This is not a certified Elo rating.`;
  const explanation = document.getElementById('partner-adjustment');
  if (state.lastChange) {
    const delta = Number(state.lastChange.delta) || 0;
    explanation.textContent = `Last change: ${delta > 0 ? '+' : ''}${delta}. ${state.lastChange.reason}`;
  } else explanation.textContent = 'Starts at 800. Completed games and sampled move quality will refine this estimate.';
  const select = document.getElementById('partner-past');
  select.replaceChildren(new Option('Current practice partner', ''));
  state.snapshots.forEach((item, index) => select.add(new Option(`${index + 1}. ${new Date(item.date).toLocaleDateString()} · ${item.rating} · ${item.style}`, item.id)));
  select.value = state.past;
}
export function mountPersonal() {
  if (document.getElementById('personal-partner')) return;
  const root = document.createElement('section');
  root.id = 'personal-partner'; root.className = 'training-room';
  root.innerHTML = `<div class="training-heading"><div><p class="eyebrow">OPPONENT SETTINGS</p><h2>Configure opponent</h2></div></div><div class="training-grid"><section class="training-panel"><h3>Practice level</h3><label for="partner-rating">Choose a practice level</label><input id="partner-rating" type="number" min="400" max="2200" step="1" inputmode="numeric" aria-describedby="partner-progress"><label><input id="partner-adaptive" type="checkbox"> Adjust from my move quality and completed games</label><p id="partner-progress" role="status"></p><p id="partner-adjustment" role="status"></p><p class="training-note">The estimate ranges from 400 to 2200. Sampled engine evaluation losses have the main influence; the result has a smaller influence. Strong play can raise it even after a loss. A median-based measure reduces the effect of one blunder, and small samples reduce confidence. This heuristic is not a certified Elo rating or a measured rating of the opponent.</p><label for="partner-style">Rival preference</label><select id="partner-style"><option value="balanced">Balanced</option><option value="attacking">Attacking</option><option value="careful">Careful</option></select><p class="training-note">Rival preferences are presets, not a learned imitation of you. Changes affect the next engine request.</p></section><section class="training-panel"><h3>Previous settings</h3><label for="partner-past">Saved practice settings</label><select id="partner-past"></select><p>Completed games save dated numeric levels and rival preferences. Select an earlier setting to challenge it again.</p><p class="training-note">Settings replay does not reproduce your personal move choices. Position rematches and games shorter than eight plies do not affect calibration.</p><p id="partner-note" role="status">Your practice profile is stored on this device.</p></section></div>`;
  document.querySelector('footer').before(root);
  document.getElementById('partner-adaptive').checked = state.adaptive;
  document.getElementById('partner-style').value = state.style;
  document.getElementById('partner-rating').addEventListener('change', event => {
    if (setPracticeRating(event.target.value) === false) event.target.value = String(engineOptions().rating);
  });
  document.getElementById('partner-adaptive').addEventListener('change', event => { state.adaptive = event.target.checked; state.past = ''; save(); refresh(); });
  document.getElementById('partner-style').addEventListener('change', event => { state.style = event.target.value; state.past = ''; save(); refresh(); });
  document.getElementById('partner-past').addEventListener('change', event => { state.past = event.target.value; save(); refresh(); });
  refresh();
}
