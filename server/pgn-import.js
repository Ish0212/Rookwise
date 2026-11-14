const { Chess } = require('chess.js');

function importPgn(pgn) {
  if (typeof pgn !== 'string' || !pgn.trim() || pgn.length > 750000) throw new Error('Provide a PGN file smaller than 750 KB');
  const records = pgn.replace(/\r\n?/g, '\n').trim().split(/\n(?=\s*\[Event\s)/).filter((record) => record.trim());
  if (records.length > 20) throw new Error('Import at most 20 games at a time');
  return records.map((record, index) => {
    const chess = new Chess();
    try { chess.loadPgn(record); }
    catch { throw new Error(`Game ${index + 1} has invalid PGN`); }
    const history = chess.history({ verbose: true });
    if (!history.length) throw new Error(`Game ${index + 1} contains no moves`);
    if (history.length > 600) throw new Error(`Game ${index + 1} exceeds 600 moves`);
    const headers = chess.getHeaders();
    return {
      headers,
      result: headers.Result || '*',
      initialFen: history[0].before,
      finalFen: chess.fen(),
      moves: history.map((move) => ({
        san: move.san,
        uci: move.from + move.to + (move.promotion || ''),
        color: move.color,
        before: move.before,
        fen: move.after,
      })),
    };
  });
}

module.exports = { importPgn };
