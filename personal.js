import { Chess } from '/vendor/chess.js';

const KEY = 'chessai.partner.v1';
const levels = ['easy', 'medium', 'hard'];
let state = { adaptive: false, style: 'balanced', level: 1, results: [], snapshots: [], past: '' };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved && Array.isArray(saved.results) && Array.isArray(saved.snapshots)) {
    state = { ...state, ...saved };
    state.level = Math.max(0, Math.min(2, Number(state.level) || 0));
    state.style = ['balanced','attacking','careful'].includes(state.style) ? state.style : 'balanced';
  }
} catch { /* A corrupt optional profile must not block chess. */ }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch { document.getElementById('partner-note')?.append(' Profile storage is unavailable.'); }
}
function snapshot() { return state.snapshots.find(item => item.id === state.past); }
export function chooseDifficulty(requested) {
  return snapshot()?.difficulty || (state.adaptive ? levels[state.level] : requested);
}
export function engineOptions() { return { style: snapshot()?.style || state.style }; }
export function describePartner() {
  const prior = snapshot();
  return prior ? `Past practice settings · ${prior.difficulty}` : state.adaptive ? `Adaptive practice · ${levels[state.level]}` : 'Your practice partner';
}
export function recordCompletedGame({ pgn, playerColor, difficulty }) {
  // Only complete standard games count; tactical rematches cannot inflate calibration.
  const game = new Chess();
  try { game.loadPgn(pgn); } catch { return; }
  if (!game.isGameOver() || game.getHeaders().SetUp === '1' || game.history().length < 8 || state.past) return;
  const identity = playerColor + ':' + game.history().join(' ');
  if (state.results.some(item => item.identity === identity)) return;
  const score = game.isDraw() ? .5 : game.turn() === playerColor ? 0 : 1;
  const playedLevel = chooseDifficulty(difficulty);
  state.results.push({ identity, score, difficulty: playedLevel, date: new Date().toISOString() });
  state.results = state.results.slice(-100);
  // Three fresh results at one setting form a small practice calibration, never an Elo estimate.
  const recent = state.results.slice(-3);
  if (state.adaptive && state.results.length % 3 === 0 && recent.every(item => item.difficulty === levels[state.level])) {
    const average = recent.reduce((sum, item) => sum + item.score, 0) / recent.length;
    if (average >= 2 / 3) state.level = Math.min(2, state.level + 1);
    if (average <= 1 / 3) state.level = Math.max(0, state.level - 1);
  }
  state.snapshots.push({ id: String(Date.now()), date: new Date().toISOString(), difficulty: playedLevel, style: state.style });
  state.snapshots = state.snapshots.slice(-20);
  save(); refresh();
}
function refresh() {
  const count = document.getElementById('partner-progress');
  if (!count) return;
  count.textContent = `${state.results.length} completed practice games recorded · Current adaptive setting: ${levels[state.level]}`;
  const select = document.getElementById('partner-past');
  select.replaceChildren(new Option('Current practice partner', ''));
  state.snapshots.forEach((item, index) => select.add(new Option(`${index + 1}. ${new Date(item.date).toLocaleDateString()} · ${item.difficulty} · ${item.style}`, item.id)));
  select.value = state.past;
}
export function mountPersonal() {
  if (document.getElementById('personal-partner')) return;
  const root = document.createElement('section');
  root.id = 'personal-partner'; root.className = 'training-room';
  root.innerHTML = `<div class="training-heading"><div><p class="eyebrow">A PARTNER FOR YOUR PRACTICE</p><h2>Choose your next challenge.</h2></div></div><div class="training-grid"><section class="training-panel"><h3>Adaptive difficulty</h3><label><input id="partner-adaptive" type="checkbox"> Adjust difficulty from my completed practice games</label><p>Every three completed games at the same level, results can move your next challenge one step up or down. This is a practice setting, not an Elo rating.</p><p id="partner-progress" role="status"></p><label for="partner-style">Rival preference</label><select id="partner-style"><option value="balanced">Balanced</option><option value="attacking">Attacking · favor checks and captures</option><option value="careful">Careful · favor quieter alternatives</option></select><p class="training-note">Rival preferences choose among engine candidates of similar strength. They are presets, not a learned imitation of you. Changes affect the next engine request.</p></section><section class="training-panel"><h3>Revisit your earlier challenge</h3><label for="partner-past">Saved practice settings</label><select id="partner-past"></select><p>Completed games save dated difficulty and rival preferences. Select an earlier setting to challenge it again.</p><p class="training-note">This is the foundation for “play your past self”: it replays past settings, not your personal move choices. Faithful style imitation needs a larger history and further validation. Position rematches and games shorter than eight plies do not affect calibration.</p><p id="partner-note" role="status">Your practice profile is stored on this device.</p></section></div>`;
  document.querySelector('footer').before(root);
  document.getElementById('partner-adaptive').checked = state.adaptive;
  document.getElementById('partner-style').value = state.style;
  document.getElementById('partner-adaptive').addEventListener('change', event => { state.adaptive = event.target.checked; state.past = ''; save(); refresh(); });
  document.getElementById('partner-style').addEventListener('change', event => { state.style = event.target.value; state.past = ''; save(); refresh(); });
  document.getElementById('partner-past').addEventListener('change', event => { state.past = event.target.value; save(); });
  refresh();
}
