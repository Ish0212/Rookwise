import { Chess } from '/vendor/chess.js';
import { pieceSvg, startPracticePosition } from './app.js';

const root = document.createElement('section');
root.className = 'training-room';
root.id = 'training';
root.innerHTML = `<div class="training-heading"><div><p class="eyebrow">MAKE YOUR GAMES YOUR TEACHER</p><h2>Your personal training room.</h2><p>Bring your history. Find the moments that mattered. Play them again.</p></div></div>
<div class="training-grid"><section class="training-panel"><h3>Bring a game</h3><p>Import PGN from Chess.com, Lichess, or any chess app. You can train here without playing a new game.</p><div class="training-links">Export your games from <a href="https://www.chess.com/games/archive" target="_blank" rel="noopener noreferrer">Chess.com ↗</a> or <a href="https://lichess.org/games/export" target="_blank" rel="noopener noreferrer">Lichess ↗</a>, then upload or paste the PGN.</div><label for="history-provider">Import public account history</label><div class="training-actions"><select id="history-provider" aria-label="Chess platform"><option value="lichess">Lichess</option><option value="chesscom">Chess.com</option></select><input id="history-username" class="history-username" placeholder="Your username" aria-label="Chess account username" maxlength="40"><button id="import-history" class="button secondary">Import history</button></div><p class="training-note">Imports up to 10 recent public games. No password or account access required.</p><label for="pgn-input">Or paste PGN</label><textarea id="pgn-input" placeholder='[White "You"]&#10;[Black "Opponent"]&#10;&#10;1. e4 e5 2. Nf3 Nc6 *' spellcheck="false"></textarea><label for="pgn-file">Or choose a .pgn file</label><input class="file-picker" id="pgn-file" type="file" accept=".pgn,.txt,application/x-chess-pgn"><div class="training-actions"><button class="button secondary" id="import-pgn">Import games</button></div><div id="training-selectors" hidden><label for="training-game">Choose a game</label><select id="training-game"></select><label for="training-side">Which side were you?</label><select id="training-side"><option value="w">White</option><option value="b">Black</option></select><div class="training-actions"><button id="analyze-game" class="button primary">Find my practice moments →</button><button id="cancel-analysis" class="button secondary" hidden>Stop</button></div><p class="training-note">Reviews up to 12 of your most recent moves in this game. Short engine searches can miss tactics; these are practice suggestions, not a full game review.</p></div><p id="training-message" class="training-message" role="status" aria-live="polite">PGN and positions are sent to your local server for parsing and engine review. Training results are saved in this browser.</p></section>
<section class="training-panel"><h3>Your scouting report</h3><p id="scout-intro">A report grounded in your moves, with positions you can revisit.</p><div id="scout-stats"><div class="scout-stat"><span>Reviewed games</span><strong>0</strong></div><div class="scout-stat"><span>Practice moments</span><strong>—</strong></div></div><div id="scout-evidence" class="training-evidence">Import a game and review your side to begin. Reports use engine comparisons of your actual moves.</div><p class="training-note">This report describes the reviewed sample. A small sample cannot establish your overall skill or a lasting playing style.</p></section>
<section class="training-panel" id="puzzle-panel"><h3>From your game to your next breakthrough.</h3><p id="puzzle-description">Personal puzzles appear here when a reviewed move gives away at least a pawn of engine evaluation. Find the engine’s stronger move from your original position.</p><div id="puzzle-content" hidden><div class="puzzle-nav"><button id="puzzle-previous" class="icon-button" aria-label="Previous puzzle">‹</button><span id="puzzle-count"></span><button id="puzzle-next" class="icon-button" aria-label="Next puzzle">›</button></div><div class="puzzle-board-wrap"><div id="puzzle-board" class="puzzle-board" role="group" aria-label="Personal puzzle board"></div></div><p id="puzzle-feedback" class="training-message" aria-live="polite"></p><div class="training-actions"><button id="puzzle-reset" class="button secondary">Try again</button><button id="puzzle-hint" class="button secondary">Show starting piece</button><button id="puzzle-answer" class="button secondary">Reveal move</button></div><div id="puzzle-evidence" class="training-evidence" hidden></div><div class="training-actions"><button id="run-it-back" class="button primary">Run it back →</button></div><p class="training-note">Run it back replaces your current saved game with this position. Play it out against the engine at your current difficulty.</p></div></section>
<section class="training-panel"><h3>A rival you can study.</h3><p>Practice from the positions you actually reached. Your reviewed games provide the evidence, and your mistakes become material for your next session.</p><div class="scout-stat"><span>Opponent today</span><strong>Stockfish · adjustable difficulty</strong></div><div class="scout-stat"><span>Personal training today</span><strong>Imported games, puzzles & rematches</strong></div><div class="scout-stat"><span>Personal calibration</span><strong>Based on completed game results</strong></div><div class="scout-stat"><span>Past-self practice</span><strong>Replay saved opponent settings</strong></div><p class="training-note">Configure your personal partner below. Result-based calibration adjusts difficulty; rival styles adjust engine move selection. Past-self practice reuses saved settings rather than recreating your historical moves or a learned model of you.</p></section></div>`;
document.querySelector('footer').before(root);
const $ = (id) => document.getElementById(id);
const KEY = 'chessai.training.v1';
let games = [];
let reports = [];
let puzzles = [];
let puzzleIndex = 0;
let puzzleGame = null;
let selected = null;
let solved = false;
let analysisController = null;
let analysisGeneration = 0;
let puzzlePromotion = null;
function message(text) { $('training-message').textContent = text; }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ games, reports: reports.slice(-30), puzzles: puzzles.slice(-50) })); }
  catch { message('Training works, but browser storage is full or unavailable. Keep your original PGN file.'); }
}
function showGames() {
  $('training-selectors').hidden = games.length === 0;
  $('training-game').replaceChildren();
  games.forEach((game, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${index + 1}. ${game.headers?.White || 'White'} vs ${game.headers?.Black || 'Black'} · ${game.result || '*'}`;
    $('training-game').append(option);
  });
}
function showReport() {
  const count = reports.reduce((sum, report) => sum + report.reviewed, 0);
  const opportunities = reports.reduce((sum, report) => sum + report.mistakes, 0);
  $('scout-stats').replaceChildren();
  for (const [label, value] of [['Reviewed game samples', reports.length], ['Moves compared', count], ['Practice moments found', opportunities], ['Saved personal puzzles', puzzles.length], ['Puzzles solved', puzzles.filter(puzzle => puzzle.solvedCount > 0).length]]) {
    const row = document.createElement('div'); row.className = 'scout-stat';
    const title = document.createElement('span'); title.textContent = label;
    const number = document.createElement('strong'); number.textContent = String(value);
    row.append(title,number); $('scout-stats').append(row);
  }
  if (reports.length) {
    const report = reports.at(-1);
    $('scout-evidence').textContent = `Latest sample: ${report.label}. Reviewed ${report.reviewed} ${report.side === 'w' ? 'white' : 'black'} moves; ${report.mistakes} lost at least 1.0 pawn of engine evaluation. ${report.mistakes ? 'Revisit those exact positions below before drawing conclusions about your style.' : 'No losses above that threshold were found in this sample. Try another game for more evidence.'}`;
  }
  if (puzzles.length) loadPuzzle(Math.min(puzzleIndex,puzzles.length-1));
}
async function api(path, body, signal) {
  const response = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The server could not complete this request.');
  return data;
}
$('pgn-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 750000) { message('Please choose a PGN file smaller than 750 KB.'); return; }
  $('pgn-input').value = await file.text();
  message('PGN file loaded. Import it to choose a game.');
});
$('import-pgn').addEventListener('click', async () => {
  const pgn = $('pgn-input').value.trim();
  if (!pgn) { message('Paste a PGN or choose a PGN file first.'); return; }
  if (pgn.length > 750000) { message('Please import less than 750 KB of PGN at a time.'); return; }
  $('import-pgn').disabled = true;
  message('Reading your games…');
  try {
    const data = await api('/api/import', {pgn});
    if (!Array.isArray(data.games) || !data.games.length) throw new Error('No games were found in that PGN.');
    games = data.games;
    showGames(); persist();
    message(`${games.length} game${games.length === 1 ? '' : 's'} imported. Choose the game and the side you played.`);
  } catch(error) { message(`Could not import: ${error.message}`); }
  finally { $('import-pgn').disabled = false; }
});
function score(result) {
  if (result.mate !== null && result.mate !== undefined) return result.mate > 0 ? 10000 - result.mate * 10 : -10000 - result.mate * 10;
  if (typeof result.cp === 'number') return result.cp;
  return 0;
}
$('analyze-game').addEventListener('click', async () => {
  if (analysisController) return;
  const imported = games[Number($('training-game').value)];
  if (!imported) return;
  const side = $('training-side').value;
  const candidates = imported.moves.filter(move => move.color === side).slice(-12);
  if (!candidates.length) { message('There are no moves for that side in this game. Choose another side or game.'); return; }
  const fingerprint = imported.moves.map(move=>move.uci).join('') + side + imported.initialFen;
  if (reports.some(report => report.fingerprint === fingerprint)) { message('This game and side have already been reviewed. Your saved puzzles are below.'); return; }
  const controller = new AbortController();
  analysisController = controller;
  const generation = ++analysisGeneration;
  $('analyze-game').disabled = true;
  $('import-pgn').disabled = true;
  $('cancel-analysis').hidden = false;
  const found = [];
  const label = `${imported.headers?.White || 'White'} vs ${imported.headers?.Black || 'Black'}`;
  try {
    for (let i=0; i<candidates.length; i++) {
      const move = candidates[i];
      message(`Reviewing move ${i+1} of ${candidates.length}… Comparing your move with the engine’s suggestion.`);
      const before = await api('/api/analyze', {fen:move.before}, controller.signal);
      const after = await api('/api/analyze', {fen:move.fen}, controller.signal);
      if (generation !== analysisGeneration) return;
      const loss = Math.round((score(before)-score(after))*(side==='w'?1:-1));
      if (loss >= 100 && before.move && before.move !== move.uci) {
        const check = new Chess(move.before);
        let best;
        try { best = check.move({from:before.move.slice(0,2),to:before.move.slice(2,4),promotion:before.move[4]}); } catch { continue; }
        if (best) found.push({fen:move.before, side, best:before.move, bestSan:best.san, played:move.san, loss, label, ply:imported.moves.indexOf(move)+1, mate:before.mate, afterMate:after.mate, pv:before.pv, depth:before.depth, attempts:0, solvedCount:0});
      }
    }
    const report = {fingerprint, label, side, reviewed:candidates.length, mistakes:found.length, date:new Date().toISOString()};
    reports.push(report);
    const newPuzzles = found.filter(item => !puzzles.some(old => old.fen === item.fen && old.best === item.best));
    puzzles.push(...newPuzzles);
    if (newPuzzles.length) puzzleIndex = puzzles.length-newPuzzles.length;
    persist(); showReport();
    message(`Review complete: ${candidates.length} moves compared. ${newPuzzles.length} new personal puzzle${newPuzzles.length === 1 ? '' : 's'} saved.${!found.length ? ' No clear practice moments found above the 1.0-pawn threshold.' : ' Your next practice positions are ready below.'}`);
  } catch(error) {
    message(error.name === 'AbortError' ? 'Review stopped. Previously saved reports and puzzles are still available.' : `Review paused: ${error.message}. You can retry the review.`);
  } finally {
    if (generation === analysisGeneration) {
      analysisController = null;
      $('analyze-game').disabled = false;
      $('import-pgn').disabled = false;
      $('cancel-analysis').hidden = true;
    }
  }
});
$('cancel-analysis').addEventListener('click', () => analysisController?.abort());
function loadPuzzle(index) {
  if (!puzzles.length) return;
  puzzleIndex = (index+puzzles.length)%puzzles.length;
  const puzzle = puzzles[puzzleIndex];
  puzzleGame = new Chess(puzzle.fen);
  selected = null; solved = false; puzzlePromotion = null;
  $('puzzle-content').hidden = false;
  $('puzzle-description').textContent = `${puzzle.side === 'w' ? 'White' : 'Black'} to move. Find a stronger continuation from your game against ${puzzle.label}.`;
  $('puzzle-count').textContent = `Personal puzzle ${puzzleIndex+1} / ${puzzles.length}`;
  $('puzzle-feedback').textContent = 'Select a piece, then its destination. Promotion moves ask for your choice.';
  $('puzzle-evidence').hidden = true;
  $('puzzle-previous').disabled = $('puzzle-next').disabled = puzzles.length < 2;
  drawPuzzle();
}
function drawPuzzle() {
  if (!puzzleGame) return;
  const puzzle = puzzles[puzzleIndex];
  const files = puzzle.side === 'w' ? 'abcdefgh' : 'hgfedcba';
  const ranks = puzzle.side === 'w' ? '87654321' : '12345678';
  const legal = selected && !solved ? puzzleGame.moves({square:selected, verbose:true}).map(move=>move.to) : [];
  const fragment = document.createDocumentFragment();
  for(let row=0;row<8;row++) for(let col=0;col<8;col++) {
    const square=files[col]+ranks[row], piece=puzzleGame.get(square);
    const button=document.createElement('button');
    button.className='square'+((files.charCodeAt(col)-97+Number(ranks[row]))%2===0?' dark':'');
    button.dataset.puzzleSquare=square;
    button.setAttribute('aria-label',`${square}, ${piece ? `${piece.color==='w'?'white':'black'} ${piece.type}`:'empty'}`);
    if(selected===square) button.classList.add('selected');
    if(legal.includes(square)) button.classList.add('legal');
    if(piece) button.classList.add('occupied');
    button.innerHTML=(piece?pieceSvg(piece.type,piece.color):'')+(col===0?`<span class="coordinate rank">${ranks[row]}</span>`:'')+(row===7?`<span class="coordinate file">${files[col]}</span>`:'');
    fragment.append(button);
  }
  $('puzzle-board').replaceChildren(fragment);
}
function continuation(puzzle) {
  const line = new Chess(puzzle.fen);
  const san = [];
  for (const uci of (puzzle.pv || [puzzle.best]).slice(0,6)) {
    try { const move = line.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]}); if(move) san.push(move.san); } catch { break; }
  }
  return san.join(' ');
}
function evidence() {
  const puzzle=puzzles[puzzleIndex];
  $('puzzle-evidence').hidden=false;
  $('puzzle-evidence').textContent=`From ${puzzle.label}, move ${puzzle.fen.split(' ')[5]}: you played ${puzzle.played}. The engine suggested ${puzzle.bestSan}. ${puzzle.mate != null || puzzle.afterMate != null ? "The engine found a change in a forced-mate evaluation." : `The evaluation difference was about ${(puzzle.loss/100).toFixed(1)} pawns.`} Suggested continuation: ${continuation(puzzle)} (depth ${puzzle.depth || '?'}). This is a short-search estimate, not proof that only one move is good.`;
}
function solve(from,to,promotion) {
  const puzzle=puzzles[puzzleIndex];
  puzzle.attempts = (puzzle.attempts || 0) + 1;
  if(from+to+(promotion||'')!==puzzle.best) {
    persist();
    selected=null;
  $('puzzle-feedback').textContent='That is not the line selected for this exercise. Give it another look.';
    drawPuzzle();return;
  }
  puzzleGame.move({from,to,...(promotion?{promotion}:{})});
  solved=true;selected=null;
  puzzle.solvedCount = (puzzle.solvedCount || 0) + 1;
  persist();
  $('puzzle-count').textContent = `Personal puzzle ${puzzleIndex+1} / ${puzzles.length} · Solved ${puzzle.solvedCount}× in ${puzzle.attempts} attempts`;
  $('puzzle-feedback').textContent=`Found it: ${puzzle.bestSan}. Now try playing out the position with Run it back.`;
  evidence();drawPuzzle();
}
$('puzzle-board').addEventListener('click',(event)=>{
  const square=event.target.closest('[data-puzzle-square]')?.dataset.puzzleSquare;
  if(!square||solved||puzzlePromotion)return;
  if(selected===square){selected=null;drawPuzzle();return;}
  if(selected){
    const choices=puzzleGame.moves({square:selected,verbose:true}).filter(move=>move.to===square);
    if(choices.length){
      if(choices[0].promotion){
        puzzlePromotion={from:selected,to:square};
        $('puzzle-feedback').textContent='Choose your promotion: ';
        for(const type of ['q','r','b','n']){
          const button=document.createElement('button');button.className='button secondary';button.textContent=({q:'Queen',r:'Rook',b:'Bishop',n:'Knight'})[type];
          button.addEventListener('click',()=>{const move=puzzlePromotion;puzzlePromotion=null;solve(move.from,move.to,type);});
          $('puzzle-feedback').append(button);
        }
      } else solve(selected,square);
      return;
    }
  }
  selected=puzzleGame.get(square)?.color===puzzles[puzzleIndex].side?square:null;drawPuzzle();
});
$('puzzle-reset').addEventListener('click',()=>loadPuzzle(puzzleIndex));
$('puzzle-previous').addEventListener('click',()=>loadPuzzle(puzzleIndex-1));
$('puzzle-next').addEventListener('click',()=>loadPuzzle(puzzleIndex+1));
$('puzzle-hint').addEventListener('click',()=>{
  if(!puzzles.length)return;
  $('puzzle-feedback').textContent=`Look for a move with the piece on ${puzzles[puzzleIndex].best.slice(0,2)}.`;
});
$('puzzle-answer').addEventListener('click',()=>{
  if(!puzzles.length)return;
  const puzzle=puzzles[puzzleIndex];
  $('puzzle-feedback').textContent=`The engine suggests ${puzzle.bestSan}. Use Try again to reset this puzzle.`;
  evidence();
});
$('run-it-back').addEventListener('click',()=>{
  const puzzle=puzzles[puzzleIndex];
  if(puzzle)startPracticePosition(puzzle.fen,puzzle.side);
});
try {
  const data=JSON.parse(localStorage.getItem(KEY)||'null');
  if(data && Array.isArray(data.games) && Array.isArray(data.reports) && Array.isArray(data.puzzles)) {
    games=data.games;reports=data.reports;puzzles=data.puzzles;
    showGames();showReport();
    if(games.length)message('Your imported games and personal training material have been restored.');
  }
} catch { message('A fresh training room is ready. Import your PGN to begin.'); }
