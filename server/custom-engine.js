const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { Chess } = require('chess.js');

const VALUES = Object.freeze({ p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 });
const STYLES = Object.freeze(['balanced', 'attacking', 'careful']);
const MATE = 100000;
const TIMEOUT = Symbol('search timeout');

// This is a small hand-written chess engine, not a trained model or an Elo estimator.
function evaluate(chess) {
  const board = chess.board();
  const pawns = { w: Array(8).fill(0), b: Array(8).fill(0) };
  const bishops = { w: 0, b: 0 };
  let phase = 0;
  for (const row of board) for (const piece of row) if (piece) {
    if (piece.type === 'p') pawns[piece.color][piece.square.charCodeAt(0) - 97] += 1;
    else if (piece.type !== 'k') phase += VALUES[piece.type];
    if (piece.type === 'b') bishops[piece.color] += 1;
  }
  let total = 0;
  for (let rank = 0; rank < 8; rank += 1) for (let file = 0; file < 8; file += 1) {
    const piece = board[rank][file];
    if (!piece) continue;
    const sign = piece.color === 'w' ? 1 : -1;
    const advance = piece.color === 'w' ? 6 - rank : rank - 1;
    const center = 3.5 - Math.abs(file - 3.5) + 3.5 - Math.abs(rank - 3.5);
    let score = VALUES[piece.type];
    if (piece.type === 'p') {
      score += advance * 7 + (3.5 - Math.abs(file - 3.5)) * 5;
      if (pawns[piece.color][file] > 1) score -= 12;
      if (!(pawns[piece.color][file - 1] || pawns[piece.color][file + 1])) score -= 10;
    }
    if (piece.type === 'n') score += center * 12 - (advance < 0 ? 18 : 0);
    if (piece.type === 'b') score += center * 6 + (advance >= 0 ? 10 : 0);
    if (piece.type === 'r' && !pawns[piece.color][file]) score += 12;
    if (piece.type === 'q') score += center * 2;
    if (piece.type === 'k') {
      score += phase < 2600 ? center * 10 : -center * 6;
      if (phase >= 2600 && advance === -1 && [2, 6].includes(file)) score += 35;
    }
    total += sign * score;
  }
  return total + (bishops.w >= 2 ? 25 : 0) - (bishops.b >= 2 ? 25 : 0);
}

function uci(move) { return move.from + move.to + (move.promotion || ''); }
function moveOrder(move) {
  return (move.captured ? VALUES[move.captured] * 10 - VALUES[move.piece] : 0)
    + (move.promotion ? VALUES[move.promotion] : 0) + (/[+#]/.test(move.san) ? 60 : 0);
}
function styleBonus(move, style) {
  if (style === 'attacking') return (move.captured ? 12 : 0) + (/[+#]/.test(move.san) ? 18 : 0);
  if (style === 'careful') return (move.san.startsWith('O-O') ? 22 : 0) + (!move.captured ? 4 : 0);
  return 0;
}
function memoryBonus(move, options) {
  // Counts belong to this exact position. They influence sampling, never legality or search scores.
  const count = options.preferences[uci(move)] || 0;
  const opening = Math.min(45, Math.log1p(count) * 12);
  const habits = options.habits;
  const capture = move.captured && habits.captureRate !== undefined ? (habits.captureRate - 0.2) * 24 : 0;
  const check = /[+#]/.test(move.san) && habits.checkRate !== undefined ? (habits.checkRate - 0.08) * 28 : 0;
  const queen = move.piece === 'q' && habits.queenRate !== undefined ? (habits.queenRate - 0.12) * 12 : 0;
  return opening + Math.max(-20, Math.min(30, capture + check + queen));
}
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normalizeOptions(options = {}) {
  const rating = options.rating === undefined ? 800 : options.rating;
  const style = options.style === undefined ? 'balanced' : options.style;
  if (typeof rating !== 'number' || !Number.isFinite(rating)) throw new Error('Rating must be a finite number');
  if (!STYLES.includes(style)) throw new Error('Invalid style');
  const preferences = {};
  if (options.preferences && typeof options.preferences === 'object' && !Array.isArray(options.preferences)) {
    for (const [move, count] of Object.entries(options.preferences).slice(0, 64)) {
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move) && typeof count === 'number' && Number.isFinite(count) && count > 0) {
        preferences[move] = Math.min(1000, count);
      }
    }
  }
  const habits = {};
  for (const key of ['captureRate', 'checkRate', 'queenRate']) {
    const value = options.habits && options.habits[key];
    if (typeof value === 'number' && Number.isFinite(value)) habits[key] = Math.max(0, Math.min(1, value));
  }
  // Optional per-search time budget (ms). Production callers omit it and get the
  // rating-derived budget; tests pass a generous one so depth assertions do not
  // depend on wall-clock time under parallel load.
  let budgetMs;
  if (options.budgetMs !== undefined) {
    if (typeof options.budgetMs !== 'number' || !Number.isFinite(options.budgetMs) || options.budgetMs <= 0) {
      throw new Error('Budget must be a positive number of milliseconds');
    }
    budgetMs = Math.min(60000, options.budgetMs);
  }
  return {
    rating: Math.max(100, Math.min(2400, rating)), style,
    preferences, habits, budgetMs,
    seed: Number.isInteger(options.seed) ? options.seed >>> 0 : Math.floor(Math.random() * 4294967296),
  };
}

function searchPosition(fen, suppliedOptions = {}) {
  const options = normalizeOptions(suppliedOptions);
  const chess = new Chess(fen);
  if (chess.isGameOver()) return { move: null, depth: 0, nodes: 0 };
  const side = chess.turn() === 'w' ? 1 : -1;
  const maxDepth = options.rating < 900 ? 1 : options.rating < 1500 ? 2 : 3;
  const budget = options.budgetMs ?? (options.rating < 900 ? 140 : options.rating < 1500 ? 280 : 500);
  const deadline = performance.now() + budget;
  const maxNodes = maxDepth === 3 ? 12000 : 4000;
  let nodes = 0;
  const checkBudget = () => {
    nodes += 1;
    if (nodes > maxNodes || performance.now() >= deadline) throw TIMEOUT;
  };
  const roots = chess.moves({ verbose: true }).sort((a, b) => moveOrder(b) - moveOrder(a));
  let scores = [];
  // Evaluate every legal root once. This gives a safe complete fallback if a deeper iteration expires.
  for (const move of roots) {
    chess.move(move);
    let score = evaluate(chess) * side;
    if (chess.isCheck() && chess.isCheckmate()) score = MATE - 1;
    else if (chess.isAttacked(move.to, chess.turn()) && !chess.isAttacked(move.to, move.color)) {
      score -= VALUES[move.promotion || move.piece] * 0.6;
    }
    chess.undo();
    scores.push({ move, score });
  }
  let completedDepth = 1;

  function negamax(depth, alpha, beta, ply) {
    checkBudget();
    const inCheck = chess.isCheck();
    if (chess.isDrawByFiftyMoves() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition()) return 0;
    let moves;
    if (depth > 0 || inCheck) {
      moves = chess.moves({ verbose: true });
      if (!moves.length) return inCheck ? -MATE + ply : 0;
    }
    if (depth === 0) return evaluate(chess) * (chess.turn() === 'w' ? 1 : -1);
    moves.sort((a, b) => moveOrder(b) - moveOrder(a));
    let best = -Infinity;
    for (const move of moves) {
      chess.move(move);
      let value;
      try { value = -negamax(depth - 1, -beta, -alpha, ply + 1); }
      finally { chess.undo(); }
      best = Math.max(best, value);
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return best;
  }

  for (let depth = 2; depth <= maxDepth; depth += 1) {
    const next = [];
    const ordered = [...scores].sort((a, b) => b.score - a.score);
    try {
      for (const root of ordered) {
        checkBudget();
        chess.move(root.move);
        let score;
        // Search each root with a full window: scores are used for sampling, so bounds are insufficient.
        try { score = -negamax(depth - 1, -Infinity, Infinity, 1); }
        finally { chess.undo(); }
        next.push({ move: root.move, score });
      }
      scores = next;
      completedDepth = depth;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break;
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0].score;
  // Always take a detected mate. Other positions sample plausible alternatives; target rating is heuristic.
  let chosen;
  if (best > MATE / 2) chosen = scores[0];
  else {
    const lossLimit = Math.max(25, 250 - options.rating * 0.13);
    const temperature = Math.max(8, 125 - options.rating * 0.055);
    const candidates = scores.filter((candidate) => candidate.score >= best - lossLimit && candidate.score > -MATE / 2);
    const weighted = (candidates.length ? candidates : [scores[0]]).map((candidate) => ({
      ...candidate, weight: Math.exp((candidate.score - best + styleBonus(candidate.move, options.style) + memoryBonus(candidate.move, options)) / temperature),
    }));
    let sample = seededRandom(options.seed)() * weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
    chosen = weighted[weighted.length - 1];
    for (const candidate of weighted) {
      sample -= candidate.weight;
      if (sample <= 0) { chosen = candidate; break; }
    }
  }
  return { move: uci(chosen.move), depth: completedDepth, nodes };
}

class CustomEngine {
  constructor() { this.queue = Promise.resolve(); this.pending = 0; this.worker = null; this.closed = false; }

  chooseMove(fen, options = {}) {
    let chess;
    let normalized;
    try {
      if (typeof fen !== 'string' || fen.length > 200 || /[\r\n]/.test(fen)) throw new Error('Invalid FEN');
      chess = new Chess(fen);
      normalized = normalizeOptions(options);
    } catch (error) { return Promise.reject(error); }
    if (this.closed) return Promise.reject(new Error('Custom engine is closed'));
    if (chess.isGameOver()) return Promise.resolve(null);
    if (this.pending >= 8) return Promise.reject(new Error('Custom engine is busy'));
    this.pending += 1;
    const task = this.queue.then(() => {
      if (this.closed) throw new Error('Custom engine is closed');
      return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { customChessSearch: true, fen, options: normalized } });
        this.worker = worker;
        let settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.worker = null;
          worker.terminate();
          if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Custom engine timed out')), 2000);
        worker.on('message', (result) => {
          try {
            if (result.error) throw new Error(result.error);
            const move = result.move;
            if (typeof move !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error('Custom engine returned invalid move');
            chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
            finish(null, move);
          } catch (error) { finish(error); }
        });
        worker.on('error', (error) => finish(error));
        worker.on('exit', () => finish(new Error('Custom engine worker stopped')));
      });
    }).finally(() => { this.pending -= 1; });
    this.queue = task.catch(() => {});
    return task;
  }

  move(fen, difficulty = 'medium', style = 'balanced') {
    if (difficulty && typeof difficulty === 'object') return this.chooseMove(fen, difficulty);
    const ratings = { easy: 450, medium: 1000, hard: 1700 };
    if (!Object.hasOwn(ratings, difficulty)) return Promise.reject(new Error('Invalid difficulty'));
    return this.chooseMove(fen, { rating: ratings[difficulty], style });
  }

  close() { this.closed = true; if (this.worker) this.worker.terminate(); }
}

if (!isMainThread && workerData && workerData.customChessSearch) {
  try { parentPort.postMessage(searchPosition(workerData.fen, workerData.options)); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}

const sharedEngine = new CustomEngine();
function chooseMove(fen, options) { return sharedEngine.chooseMove(fen, options); }

module.exports = { chooseMove, CustomEngine, searchPosition, evaluate, STYLES };
