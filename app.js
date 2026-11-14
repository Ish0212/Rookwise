import { Chess } from '/vendor/chess.js';
import { pieces } from './pieces.js';
import { observeGame, learnedOptions } from './memory.js';
import { chooseDifficulty, recordCompletedGame, engineOptions, describePartner, mountPersonal, setPracticeRating } from './personal.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'chessai.session.v1';
const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const paths = {
  p: '<circle cx="32" cy="18" r="8"/><path d="M26 27h12l-2 7 7 13H21l7-13z"/><path d="M19 48h26v6H19z"/>',
  r: '<path d="M19 11h7v7h5v-7h6v7h5v-7h6v16l-7 6 2 15H23l2-15-6-6z"/><path d="M20 48h26v6H20zM25 27h16"/>',
  b: '<path d="M32 9C26 16 20 20 22 27c1 4 5 6 7 7l-7 13h20l-7-13c7-3 10-8 6-14z"/><path d="m32 17 5 9M20 48h24v6H20z"/>',
  n: '<path d="m23 46 2-12-9 3-3-8 9-12 11-5 2-7 5 6c14 5 12 23 6 35z"/><path d="m24 18 8 1-7 9M20 48h28v6H20z"/><circle cx="31" cy="21" r="1.5" fill="currentColor" stroke="none"/>',
  q: '<path d="m18 20 7 10 7-15 7 15 7-10-6 25H24z"/><circle cx="17" cy="17" r="3.5"/><circle cx="32" cy="12" r="3.5"/><circle cx="47" cy="17" r="3.5"/><path d="M23 41h18M20 48h24v6H20z"/>',
  k: '<path d="M32 5v13m-6-8h12" fill="none"/><path d="M32 22c-9-13-21-2-14 8l7 15h14l7-15c7-10-5-21-14-8z"/><path d="M24 39h16M20 48h24v6H20z"/>'
};
function pieceSvg(type, color) {
  return pieces[color + type.toUpperCase()].replace('<svg ', '<svg class="piece" aria-hidden="true" ');
}
let game = new Chess();
let resigned = false;
let performanceStatus = '';
const reviewedGames = new Set();
let playerColor = 'w';
let difficulty = 'medium';
let orientation = 'w';
let selected = null;
let reviewPly = null;
let busy = false;
let engineError = '';
let request = null;
let generation = 0;
let promotion = null;
let soundEnabled = false;
let audioContext;
let storageAvailable = true;
let restored = false;

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!['w','b'].includes(data.playerColor) || !['easy','medium','hard'].includes(data.difficulty) || typeof data.pgn !== 'string') throw new Error('Invalid saved game');
    const candidate = new Chess();
    if (data.pgn.trim()) candidate.loadPgn(data.pgn);
    game = candidate;
    resigned = data.resigned === true;
    playerColor = data.playerColor;
    difficulty = data.difficulty;
    orientation = ['w','b'].includes(data.orientation) ? data.orientation : playerColor;
    restored = game.history().length > 0;
  } catch (error) {
    // Keep a playable fresh board if a stale or corrupted save cannot be loaded.
    $('announcement').textContent = 'The saved game could not be restored. A fresh game is ready.';
  }
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pgn: game.pgn(), playerColor, difficulty, orientation, resigned }));
  } catch { storageAvailable = false; }
  $('save-status').textContent = storageAvailable ? 'Saved automatically on this device' : 'Device storage unavailable · Export to keep your game';
}
function history() { return game.history({ verbose: true }); }
function viewingGame() {
  if (reviewPly === null) return game;
  const moves = history();
  return new Chess(reviewPly === 0 ? (moves[0]?.before || game.fen()) : moves[reviewPly - 1].after);
}
function positionPly() { return reviewPly === null ? history().length : reviewPly; }
function colorName(color) { return color === 'w' ? 'White' : 'Black'; }
function isFinished() { return resigned || game.isGameOver(); }
function canMove() { return reviewPly === null && !busy && !isFinished() && game.turn() === playerColor; }
function statusText() {
  if (resigned) return ['You resigned.', `${colorName(playerColor === 'w' ? 'b' : 'w')} wins by resignation.`];
  if (game.isCheckmate()) return [game.turn() === playerColor ? 'Checkmate.' : 'Checkmate.', `${colorName(game.turn() === 'w' ? 'b' : 'w')} wins by checkmate. Start a new game whenever you’re ready.`];
  if (game.isStalemate()) return ['Draw.', 'Draw by stalemate. There are no legal moves.'];
  if (game.isThreefoldRepetition()) return ['Draw.', 'Draw by threefold repetition.'];
  if (game.isInsufficientMaterial()) return ['Draw.', 'Draw by insufficient material.'];
  if (game.isDraw()) return ['Draw.', 'Draw under the fifty-move rule.'];
  if (engineError) return ['Engine unavailable.', 'Your position is safe. Retry to continue your game.'];
  if (busy) return ['Computer thinking…', 'Waiting for the computer to move.'];
  if (game.isCheck()) return [game.turn() === playerColor ? 'Your king is in check.' : 'Check.', `${colorName(game.turn())} must get out of check.`];
  return game.turn() === playerColor ? ['Your move.', `You’re playing ${colorName(playerColor).toLowerCase()}. Take your time.`] : ['Ready for a reply.', 'Your practice partner will move next.'];
}
function renderBoard() {
  const view = viewingGame();
  const moves = history();
  const last = moves[positionPly() - 1];
  const legal = selected && canMove() ? game.moves({ square: selected, verbose: true }).map(m => m.to) : [];
  const focusedSquare = document.activeElement?.dataset.square;
  const files = orientation === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = orientation === 'w' ? '87654321' : '12345678';
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const square = files[col] + ranks[row];
    const piece = view.get(square);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.square = square;
    button.className = 'square' + ((files.charCodeAt(col) - 97 + Number(ranks[row])) % 2 === 0 ? ' dark' : '');
    if (last && [last.from, last.to].includes(square)) button.classList.add('last-move');
    if (selected === square && reviewPly === null) button.classList.add('selected');
    if (legal.includes(square)) button.classList.add('legal');
    if (piece) button.classList.add('occupied');
    if (piece?.type === 'k' && piece.color === view.turn() && view.isCheck()) button.classList.add('check');
    button.setAttribute('aria-label', `${square}, ${piece ? `${colorName(piece.color).toLowerCase()} ${names[piece.type]}` : 'empty'}${legal.includes(square) ? ', legal destination' : ''}`);
    button.setAttribute('aria-pressed', String(selected === square));
    button.innerHTML = (piece ? pieceSvg(piece.type, piece.color) : '') + (col === 0 ? `<span class="coordinate rank">${ranks[row]}</span>` : '') + (row === 7 ? `<span class="coordinate file">${files[col]}</span>` : '');
    fragment.append(button);
  }
  $('board').replaceChildren(fragment);
  if (focusedSquare) $('board').querySelector(`[data-square="${focusedSquare}"]`)?.focus({ preventScroll: true });
}
function renderMoves() {
  const moves = history();
  const scroll = $('moves').scrollTop;
  if (!moves.length) {
    $('moves').innerHTML = '<div class="empty-history"><span>♙</span>No moves yet</div>';
  } else {
    const fragment = document.createDocumentFragment();
    let row;
    let rowNumber;
    for (let j = 0; j < moves.length; j++) {
      const move = moves[j];
      const fullmove = Number(move.before.split(' ')[5]);
      if (!row || fullmove !== rowNumber) {
        rowNumber = fullmove;
        row = document.createElement('div');
        row.className = 'move-row';
        const number = document.createElement('span');
        number.className = 'move-number';
        number.textContent = `${fullmove}.`;
        row.append(number);
        if (move.color === 'b') row.append(document.createElement('span'));
        fragment.append(row);
      }
      const button = document.createElement('button');
      button.className = 'move-button' + (positionPly() === j + 1 ? ' active' : '');
      button.dataset.ply = String(j + 1);
      button.textContent = move.san;
      button.setAttribute('aria-label', `View move ${fullmove}, ${colorName(move.color)} ${move.san}`);
      if (positionPly() === j + 1) button.setAttribute('aria-current', 'step');
      row.append(button);
    }
    $('moves').replaceChildren(fragment);
    $('moves').scrollTop = reviewPly === null ? $('moves').scrollHeight : scroll;
  }
  const ply = positionPly();
  $('first').disabled = $('previous').disabled = ply === 0;
  $('next').disabled = ply === moves.length;
  $('last').disabled = reviewPly === null;
  $('replay-label').textContent = reviewPly === null ? 'Live position' : `Position ${ply} / ${moves.length}`;
  if (reviewPly === 0) $('replay-label').textContent = 'Starting position';
  $('return-live').hidden = reviewPly === null;
}
async function reviewPerformance() {
  const pgn = game.pgn();
  const color = playerColor;
  const key = color + ':' + game.history().join(' ');
  if (reviewedGames.has(key)) return;
  reviewedGames.add(key);
  const snapshot = { pgn, playerColor: color, difficulty, resigned };
  observeGame(history(), color, key);
  const moves = history().filter(move => move.color === color);
  if (game.getHeaders().SetUp === '1' || history().length < 8) {
    performanceStatus = 'Not enough standard-game moves to estimate performance.';
    return;
  }
  const sample = moves.length <= 12 ? moves : Array.from({ length: 12 }, (_, i) => moves[Math.floor(i * (moves.length - 1) / 11)]);
  const losses = [];
  const stillCurrent = () => color === playerColor && key === color + ':' + game.history().join(' ');
  const update = text => { if (stillCurrent()) { performanceStatus = text; $('performance-status').textContent = text; } };
  async function evaluate(fen) {
    const position = new Chess(fen);
    if (position.isCheckmate()) return position.turn() === 'w' ? -10000 : 10000;
    if (position.isDraw()) return 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error('Analysis unavailable');
      if (Number.isFinite(result.mate)) return Math.sign(result.mate) * 10000;
      if (!Number.isFinite(result.cp)) throw new Error('No evaluation');
      return result.cp;
    } finally { clearTimeout(timer); }
  }
  let complete = true;
  try {
    for (const [index, move] of sample.entries()) {
      update(`Reviewing move quality ${index + 1}/${sample.length}…`);
      const before = await evaluate(move.before);
      const after = await evaluate(move.after);
      losses.push(Math.max(0, Math.min(1000, (before - after) * (color === 'w' ? 1 : -1))));
    }
  } catch { complete = false; }
  losses.sort((a, b) => a - b);
  const analysis = losses.length ? {
    meanLossCp: losses.reduce((sum, loss) => sum + loss, 0) / losses.length,
    medianLossCp: (losses[Math.floor((losses.length - 1) / 2)] + losses[Math.floor(losses.length / 2)]) / 2,
    samples: losses.length, totalMoves: moves.length,
  } : undefined;
  recordCompletedGame({ ...snapshot, analysis });
  update(complete ? `Performance updated from ${losses.length} sampled moves. See Opponent for the change.` : `Analysis interrupted after ${losses.length} moves. Estimate uses the available evidence.`);
  if (stillCurrent()) render();
}
function render() {
  if (isFinished()) void reviewPerformance();
  const [title, detail] = statusText();
  $('status').textContent = reviewPly !== null ? 'Reviewing position' : title;
  $('status-detail').textContent = reviewPly !== null ? 'You’re reviewing an earlier position. Return to live play to make your next move.' : detail;
  $('game-label').textContent = reviewPly !== null ? 'GAME REVIEW' : isFinished() ? 'GAME COMPLETE' : busy ? 'ENGINE THINKING' : 'GAME IN PROGRESS';
  $('turn-label').textContent = `${colorName(viewingGame().turn())} to move`;
  $('turn-dot').classList.toggle('black', viewingGame().turn() === 'b');
  $('move-number').textContent = `Move ${viewingGame().fen().split(' ')[5]}`;
  $('level-tag').textContent = String(engineOptions().rating || 800);
  $('session-level').textContent = `${engineOptions().rating || 800} · estimated`;
  $('performance-status').textContent = performanceStatus;
  $('session-color').textContent = colorName(playerColor);
  $('player-detail').textContent = `${colorName(playerColor)} pieces · Your perspective`;
  $('opponent-detail').textContent = `${describePartner()} · ${colorName(playerColor === 'w' ? 'b' : 'w')} pieces`;
  $('engine-indicator').classList.toggle('thinking', busy);
  $('error').hidden = !engineError;
  $('error-text').textContent = engineError;
  $('takeback').disabled = history().length === 0 || isFinished();
  $('resign').disabled = isFinished() || history().length === 0;
  $('export').disabled = history().length === 0;
  renderBoard();
  renderMoves();
}
function cancelEngine() {
  generation++;
  request?.abort();
  request = null;
  busy = false;
  engineError = '';
}
function chime() {
  if (!soundEnabled) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(420, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(280, audioContext.currentTime + .1);
    gain.gain.setValueAtTime(.05, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .12);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + .13);
  } catch { /* Audio is an optional enhancement. */ }
}
async function askEngine() {
  if (busy || isFinished() || game.turn() === playerColor) return;
  const currentGeneration = generation;
  const fen = game.fen();
  const controller = new AbortController();
  request = controller;
  busy = true;
  engineError = '';
  selected = null;
  render();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  try {
    const response = await fetch('/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen, difficulty: chooseDifficulty(difficulty), ...engineOptions(), ...learnedOptions(fen) }), signal: controller.signal });
    const result = await response.json();
    if (currentGeneration !== generation || game.fen() !== fen) return;
    if (!response.ok) throw new Error(result.error || 'The engine could not respond.');
    if (typeof result.move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(result.move)) throw new Error('The engine returned an invalid move.');
    let move;
    try { move = game.move({ from: result.move.slice(0,2), to: result.move.slice(2,4), ...(result.move[4] ? { promotion: result.move[4] } : {}) }); }
    catch { throw new Error('The engine returned an illegal move.'); }
    if (!move) throw new Error('The engine returned an illegal move.');
    chime();
    save();
  } catch (error) {
    if (currentGeneration !== generation) return;
    engineError = timedOut ? 'The engine took too long to respond. Please try again.' : error.name === 'AbortError' ? 'The engine request was interrupted. Please try again.' : (error.message === 'Failed to fetch' ? 'Unable to reach the engine. Check that the server is running, then retry.' : error.message);
  } finally {
    clearTimeout(timeout);
    if (currentGeneration === generation) { busy = false; request = null; render(); }
  }
}
function makeMove(from, to, promoted) {
  if (!canMove()) return;
  try {
    const move = game.move({ from, to, ...(promoted ? { promotion: promoted } : {}) });
    if (!move) return;
    selected = null;
    engineError = '';
    chime();
    save();
    render();
    void askEngine();
  } catch { selected = null; renderBoard(); }
}
function openPromotion(from, to) {
  promotion = { from, to };
  const options = $('promotion-options');
  options.replaceChildren();
  for (const type of ['q','r','b','n']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.promotion = type;
    button.setAttribute('aria-label', `Promote to ${names[type]}`);
    button.innerHTML = pieceSvg(type, playerColor);
    options.append(button);
  }
  $('promotion-dialog').showModal();
}
$('board').addEventListener('click', (event) => {
  const square = event.target.closest('[data-square]')?.dataset.square;
  if (!square || !canMove()) return;
  if (selected === square) { selected = null; renderBoard(); return; }
  if (selected) {
    const move = game.moves({ square: selected, verbose: true }).find(m => m.to === square);
    if (move) {
      if (move.promotion) openPromotion(selected, square);
      else makeMove(selected, square);
      return;
    }
  }
  const piece = game.get(square);
  selected = piece?.color === playerColor ? square : null;
  renderBoard();
});
$('board').addEventListener('keydown', (event) => {
  const buttons = [...$('board').querySelectorAll('button')];
  const index = buttons.indexOf(event.target);
  const offsets = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: -8, ArrowDown: 8 };
  if (event.key === 'Escape') { selected = null; renderBoard(); return; }
  if (offsets[event.key] !== undefined) {
    event.preventDefault();
    const next = index + offsets[event.key];
    if (next >= 0 && next < 64 && !(event.key === 'ArrowRight' && index % 8 === 7) && !(event.key === 'ArrowLeft' && index % 8 === 0)) buttons[next].focus();
  }
});
$('promotion-options').addEventListener('click', (event) => {
  const type = event.target.closest('[data-promotion]')?.dataset.promotion;
  if (!type || !promotion) return;
  const { from, to } = promotion;
  promotion = null;
  $('promotion-dialog').close();
  makeMove(from, to, type);
});
$('cancel-promotion').addEventListener('click', () => { promotion = null; $('promotion-dialog').close(); });
$('promotion-dialog').addEventListener('cancel', () => { promotion = null; });
$('new-game').addEventListener('click', () => {
  $('setup-form').elements.color.value = playerColor;
  $('setup-form').elements.difficulty.value = difficulty;
  $('setup-form').elements.rating.value = engineOptions().rating;
  $('setup-dialog').showModal();
});
$('close-setup').addEventListener('click', () => $('setup-dialog').close());
$('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  cancelEngine();
  const data = new FormData(event.currentTarget);
  playerColor = data.get('color');
  difficulty = data.get('difficulty');
  setPracticeRating(Number(data.get('rating')));
  orientation = playerColor;
  game = new Chess();
  resigned = false;
  performanceStatus = '';
  selected = null;
  reviewPly = null;
  promotion = null;
  $('setup-dialog').close();
  save();
  render();
  void askEngine();
});
function review(ply) {
  selected = null;
  reviewPly = ply === null ? null : Math.max(0, Math.min(history().length, ply));
  render();
}
$('moves').addEventListener('click', (event) => {
  const ply = event.target.closest('[data-ply]')?.dataset.ply;
  if (ply) review(Number(ply));
});
$('first').addEventListener('click', () => review(0));
$('previous').addEventListener('click', () => review(positionPly() - 1));
$('next').addEventListener('click', () => { const next = positionPly() + 1; review(next >= history().length ? null : next); });
$('last').addEventListener('click', () => review(null));
$('return-live').addEventListener('click', () => review(null));
$('flip').addEventListener('click', () => { orientation = orientation === 'w' ? 'b' : 'w'; save(); renderBoard(); });
$('sound').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  $('sound').setAttribute('aria-pressed', String(soundEnabled));
  $('sound').setAttribute('aria-label', `Turn sound ${soundEnabled ? 'off' : 'on'}`);
  $('sound').title = `Sound ${soundEnabled ? 'on' : 'off'}`;
  chime();
});
$('takeback').addEventListener('click', () => {
  if (!history().length) return;
  cancelEngine();
  game.undo();
  if (game.turn() !== playerColor && history().length) game.undo();
  reviewPly = null;
  selected = null;
  save();
  render();
  void askEngine();
});
$('retry').addEventListener('click', () => { void askEngine(); });
$('resign').addEventListener('click', () => {
  if (!isFinished() && history().length) $('resign-dialog').showModal();
});
$('cancel-resign').addEventListener('click', () => $('resign-dialog').close());
$('confirm-resign').addEventListener('click', () => {
  $('resign-dialog').close();
  if (isFinished()) return;
  cancelEngine();
  resigned = true;
  selected = null;
  reviewPly = null;
  game.header('Result', playerColor === 'w' ? '0-1' : '1-0', 'Termination', 'resignation');
  save(); render();
});
$('export').addEventListener('click', () => {
  game.header('Event', 'Rookmate practice', 'White', playerColor === 'w' ? 'You' : `Rookmate (${engineOptions().rating || 800})`, 'Black', playerColor === 'b' ? 'You' : `Rookmate (${engineOptions().rating || 800})`, 'Result', resigned ? (playerColor === 'w' ? '0-1' : '1-0') : game.isCheckmate() ? (game.turn() === 'w' ? '0-1' : '1-0') : game.isDraw() ? '1/2-1/2' : '*');
  const url = URL.createObjectURL(new Blob([game.pgn() + '\n'], { type: 'application/x-chess-pgn' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `chess-ai-${new Date().toISOString().slice(0,10)}.pgn`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  save();
});
restore();
save();
render();
mountPersonal();
if (restored) $('announcement').textContent = 'Your saved game has been restored.';
void askEngine();

/* A reviewed position can become a normal, locally saved practice game. */
export function startPracticePosition(fen, color) {
  const candidate = new Chess(fen);
  cancelEngine();
  game = candidate;
  resigned = false;
  performanceStatus = '';
  playerColor = color;
  orientation = color;
  selected = null;
  reviewPly = null;
  save();
  render();
  window.location.hash = 'play';
  updateView();
  document.querySelector('.play-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  void askEngine();
}
export { pieceSvg };
function updateView() {
  const view = window.location.hash === '#training' ? 'training' : window.location.hash === '#personal-partner' ? 'partner' : 'play';
  document.body.dataset.view = view;
  document.querySelectorAll('[data-view-link]').forEach(link => {
    if (link.dataset.viewLink === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${view === 'training' ? 'Train' : view === 'partner' ? 'Opponent' : 'Play'} • Rookmate`;
}
window.addEventListener('hashchange', updateView);
updateView();
void import('./training.js').catch((error) => { console.error('Training room could not load', error); });
