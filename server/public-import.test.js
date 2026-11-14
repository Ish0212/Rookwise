const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicImporter } = require('./public-import');
const PGN = '[Event "Public game"]\n[White "Player"]\n[Black "Rival"]\n[Result "*"]\n\n1. e4 e5 *';

test('Lichess export has a bounded game count, fixed host, and application user agent', async () => {
  const importer = new PublicImporter({ fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://lichess.org');
    assert.equal(parsed.pathname, '/api/games/user/player');
    assert.equal(parsed.searchParams.get('max'), '2');
    assert.equal(parsed.searchParams.get('ongoing'), 'false');
    assert.equal(options.headers.Accept, 'application/x-chess-pgn');
    assert.match(options.headers['User-Agent'], /ChessAI/);
    assert.equal(options.redirect, 'error');
    return new Response(PGN);
  } });
  const result = await importer.import({ provider: 'lichess', username: 'Player', limit: 2 });
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].moves[0].uci, 'e2e4');
});

test('Chess.com archive URLs are reconstructed and standard games imported newest first', async () => {
  const calls = [];
  const importer = new PublicImporter({ fetchImpl: async (url) => {
    calls.push(url);
    if (url.endsWith('/archives')) return Response.json({ archives: ['https://malicious.invalid/path/2026/10', 'https://api.chess.com/pub/player/player/games/2026/11'] });
    return Response.json({ games: [{ rules: 'chess960', pgn: PGN }, { rules: 'chess', pgn: PGN }] });
  } });
  const result = await importer.import({ provider: 'chesscom', username: 'Player', limit: 1 });
  assert.equal(result.games.length, 1);
  assert.deepEqual(calls, ['https://api.chess.com/pub/player/player/games/archives', 'https://api.chess.com/pub/player/player/games/2026/11']);
});

test('public import validates usernames/providers/limits before network access', async () => {
  const importer = new PublicImporter({ fetchImpl: () => { throw new Error('Network must not be called'); } });
  for (const args of [
    { provider: 'other', username: 'Player' },
    { provider: 'lichess', username: 'https://evil.invalid/' },
    { provider: 'chesscom', username: 'Player', limit: 21 },
  ]) await assert.rejects(importer.import(args), (error) => error.status === 400);
});

test('rate limits apply a cooldown and do not retry provider requests', async () => {
  let calls = 0;
  const importer = new PublicImporter({ fetchImpl: async () => {
    calls += 1;
    return new Response('', { status: 429 });
  } });
  await assert.rejects(importer.import({ provider: 'lichess', username: 'Player' }), (error) => error.status === 429);
  await assert.rejects(importer.import({ provider: 'lichess', username: 'Player' }), (error) => error.status === 429);
  assert.equal(calls, 1);
});

test('missing accounts and oversized provider responses are reported clearly', async () => {
  const missing = new PublicImporter({ fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(missing.import({ provider: 'lichess', username: 'Nobody' }), (error) => error.status === 404);
  const oversized = new PublicImporter({ maxBytes: 20, fetchImpl: async () => new Response(PGN) });
  await assert.rejects(oversized.import({ provider: 'lichess', username: 'Player' }), /too large/);
});

test('remote requests run serially across separate imports', async () => {
  let active = 0;
  let maxActive = 0;
  const importer = new PublicImporter({ fetchImpl: async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(PGN);
  } });
  await Promise.all([importer.import({ provider: 'lichess', username: 'Player' }), importer.import({ provider: 'lichess', username: 'Other' })]);
  assert.equal(maxActive, 1);
});
