const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { Chess } = require('chess.js');

const LEVELS = Object.freeze({
  easy: { skill: 0, time: 150 },
  medium: { skill: 8, time: 450 },
  hard: { skill: 20, time: 1200 },
});
const STYLES = Object.freeze(['balanced', 'attacking', 'careful']);

function selectStyleMove(fen, engineMove, candidates, style) {
  if (style === 'balanced') return null;
  const best = candidates.get(1);
  if (!best || best.cp === null || best.mate !== null) return null;
  // Compare scores from a completed common depth. Never replace a forced mate line.
  const eligible = [...candidates.values()].filter((candidate) => candidate.depth === best.depth && candidate.mate === null && candidate.cp !== null && candidate.cp >= best.cp - 60);
  const choices = eligible.flatMap((candidate) => {
    const uci = candidate.pv[0];
    if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return [];
    const chess = new Chess(fen);
    try {
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      const forcing = Boolean(move.captured || /[+#]/.test(move.san));
      return [{ ...candidate, move: uci, preferred: style === 'attacking' ? forcing : !forcing }];
    } catch { return []; }
  });
  // Preserve weaker skill selection if its move has no comparable candidate score.
  if (!choices.some((candidate) => candidate.move === engineMove)) return null;
  return choices.filter((candidate) => candidate.preferred).sort((a, b) => b.cp - a.cp)[0] || null;
}

class StockfishEngine {
  constructor(options = {}) {
    this.enginePath = options.enginePath || path.join(__dirname, 'node_modules/stockfish/bin/stockfish-18-lite-single.js');
    this.spawn = options.spawn || spawn;
    this.startTimeout = options.startTimeout || 10000;
    this.searchTimeout = options.searchTimeout || 8000;
    this.maxQueue = options.maxQueue || 12;
    this.pending = 0;
    this.queue = Promise.resolve();
    this.proc = null;
    this.reader = null;
    this.waiter = null;
    this.closed = false;
  }

  send(command) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) throw new Error('Chess engine is unavailable');
    this.proc.stdin.write(command + '\n');
  }

  waitFor(match, timeout, onLine = () => {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('Chess engine timed out'));
        this.reset();
      }, timeout);
      this.waiter = {
        match,
        onLine,
        resolve: (line) => { clearTimeout(timer); this.waiter = null; resolve(line); },
        reject: (error) => { clearTimeout(timer); this.waiter = null; reject(error); },
      };
    });
  }

  reset(error = new Error('Chess engine stopped')) {
    if (this.waiter) this.waiter.reject(error);
    const proc = this.proc;
    this.proc = null;
    if (this.reader) this.reader.close();
    this.reader = null;
    if (proc && !proc.killed) proc.kill();
  }

  async initialize() {
    if (this.proc) return;
    const proc = this.spawn(process.execPath, [this.enginePath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.reader = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => {
      if (this.proc === proc && this.waiter) {
        this.waiter.onLine(line.trim());
        if (this.waiter.match(line.trim())) this.waiter.resolve(line.trim());
      }
    });
    const fail = () => {
      if (this.proc === proc) this.reset(new Error('Chess engine exited unexpectedly'));
    };
    proc.on('error', fail);
    proc.on('exit', fail);
    proc.stdin.on('error', fail);
    proc.stderr.on('data', () => {});
    const initialized = this.waitFor((line) => line === 'uciok', this.startTimeout);
    this.send('uci');
    await initialized;
    this.send('setoption name Hash value 32');
    const ready = this.waitFor((line) => line === 'readyok', this.startTimeout);
    this.send('isready');
    await ready;
  }

  move(fen, difficulty = 'medium', style = 'balanced') {
    return this.analyze(fen, difficulty, { style }).then((result) => result.move);
  }

  analyze(fen, difficulty = 'medium', options = {}) {
    let chess;
    if (typeof fen !== 'string' || fen.length > 200 || /[\r\n]/.test(fen)) return Promise.reject(new Error('Invalid FEN'));
    try { chess = new Chess(fen); } catch { return Promise.reject(new Error('Invalid FEN')); }
    if (!Object.hasOwn(LEVELS, difficulty)) return Promise.reject(new Error('Invalid difficulty'));
    if (options.style && !STYLES.includes(options.style)) return Promise.reject(new Error('Invalid style'));
    if (this.closed) return Promise.reject(new Error('Chess engine is closed'));
    if (chess.isGameOver()) return Promise.resolve({ move: null, cp: chess.isCheckmate() ? null : 0, mate: chess.isCheckmate() ? 0 : null, pv: [], depth: 0 });
    if (this.pending >= this.maxQueue) return Promise.reject(new Error('Chess engine is busy; please try again'));
    this.pending += 1;
    const result = this.queue.then(async () => {
      if (this.closed) throw new Error('Chess engine is closed');
      try {
        await this.initialize();
        const level = LEVELS[difficulty];
        this.send('ucinewgame');
        this.send(`setoption name Skill Level value ${level.skill}`);
        this.send(`setoption name MultiPV value ${options.style && options.style !== 'balanced' ? 5 : 1}`);
        const ready = this.waitFor((line) => line === 'readyok', this.startTimeout);
        this.send('isready');
        await ready;
        this.send('position fen ' + chess.fen());
        let score = { cp: null, mate: null, pv: [], depth: 0 };
        const candidates = new Map();
        const perspective = chess.turn() === 'w' ? 1 : -1;
        const bestMove = this.waitFor((line) => line.startsWith('bestmove '), this.searchTimeout, (line) => {
          const value = line.match(/\bscore (cp|mate) (-?\d+)/);
          if (!value || /\b(?:lowerbound|upperbound)\b/.test(line)) return;
          const pv = line.match(/\bpv (.+)$/);
          const depth = line.match(/\bdepth (\d+)/);
          const candidate = {
            cp: value[1] === 'cp' ? Number(value[2]) : null,
            mate: value[1] === 'mate' ? Number(value[2]) : null,
            pv: pv ? pv[1].trim().split(/\s+/) : [],
            depth: depth ? Number(depth[1]) : 0,
          };
          const multipv = line.match(/\bmultipv (\d+)/);
          const index = multipv ? Number(multipv[1]) : 1;
          candidates.set(index, candidate);
          if (index === 1) score = {
            cp: value[1] === 'cp' ? Number(value[2]) * perspective : null,
            mate: value[1] === 'mate' ? Number(value[2]) * perspective : null,
            pv: pv ? pv[1].trim().split(/\s+/) : [],
            depth: depth ? Number(depth[1]) : 0,
          };
        });
        const time = options.time || level.time;
        this.send(`go movetime ${time}`);
        const line = await bestMove;
        let move = line.split(/\s+/)[1];
        const styled = selectStyleMove(chess.fen(), move, candidates, options.style || 'balanced');
        if (styled) {
          move = styled.move;
          score = { cp: styled.cp * perspective, mate: null, pv: styled.pv, depth: styled.depth };
        }
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error('Chess engine returned an invalid move');
        try { chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }); }
        catch { throw new Error('Chess engine returned an illegal move'); }
        return { move, ...score };
      } catch (error) {
        this.reset();
        throw error;
      }
    }).finally(() => { this.pending -= 1; });
    // A failed search must not poison later requests; the next request starts a fresh engine.
    this.queue = result.catch(() => {});
    return result;
  }

  close() {
    this.closed = true;
    this.reset();
  }
}

module.exports = { StockfishEngine, LEVELS, STYLES, selectStyleMove };
