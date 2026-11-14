// Local observed-move memory, not a pretrained human chess model.
const KEY = 'rookmate.memory.v1';
let memory = { positions: {}, games: [], moves: 0, captures: 0, checks: 0, queens: 0 };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (saved && saved.positions && Array.isArray(saved.games) && Number.isFinite(saved.moves)) memory = saved;
} catch { /* Optional memory must not block play. */ }
const positionKey = fen => fen.split(' ').slice(0, 4).join(' ');
function save() { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* Play remains available if storage is full. */ } }
export function observeGame(moves, color, identity) {
  if (!Array.isArray(moves) || !['w','b'].includes(color) || memory.games.includes(identity)) return;
  memory.games.push(identity); memory.games = memory.games.slice(-5000);
  for (const move of moves) {
    if (move.color !== color || typeof move.before !== 'string') continue;
    const uci = move.uci || move.from + move.to + (move.promotion || '');
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) continue;
    const key = positionKey(move.before);
    const counts = memory.positions[key] || (memory.positions[key] = {});
    counts[uci] = Math.min(1000, (counts[uci] || 0) + 1);
    memory.moves++;
    memory.captures += /x/.test(move.san) ? 1 : 0;
    memory.checks += /[+#]/.test(move.san) ? 1 : 0;
    memory.queens += /^Q/.test(move.san) ? 1 : 0;
  }
  // Keep a small local repertoire so requests and browser storage stay bounded.
  const keys = Object.keys(memory.positions);
  for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete memory.positions[key];
  save();
}
export function learnedOptions(fen) {
  const preferences = memory.positions[positionKey(fen)] || {};
  if (memory.moves < 20) return { preferences };
  return { preferences, habits: { captureRate: memory.captures / memory.moves, checkRate: memory.checks / memory.moves, queenRate: memory.queens / memory.moves } };
}
