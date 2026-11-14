const { importPgn } = require('./pgn-import');

class ImportError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function normalizeUsername(provider, input) {
  if (typeof input !== 'string') throw new ImportError('Enter a public username or profile URL', 400);
  let name = input.trim();
  if (/^(?:https?:\/\/)?(?:www\.)?(?:chess\.com|lichess\.org)\//i.test(name)) {
    let profile;
    try { profile = new URL(/^https?:\/\//i.test(name) ? name : `https://${name}`); }
    catch { throw new ImportError('Enter a valid public profile URL', 400); }
    const expected = provider === 'chesscom' ? ['chess.com', 'www.chess.com'] : ['lichess.org', 'www.lichess.org'];
    const match = profile.pathname.match(provider === 'chesscom' ? /^\/(?:member|members)\/([^/]+)\/?$/ : /^\/@\/([^/]+)\/?$/);
    if (!expected.includes(profile.hostname.toLowerCase()) || !match) throw new ImportError('The profile URL must match the selected platform', 400);
    name = match[1];
  }
  name = name.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(name)) throw new ImportError('Enter a valid public username (2–30 letters, numbers, underscores, or hyphens)', 400);
  return name;
}
function encodeCursor(data) { return Buffer.from(JSON.stringify(data)).toString('base64url'); }
function decodeCursor(raw, provider, username, since) {
  if (raw == null) return null;
  try {
    if (typeof raw !== 'string' || raw.length > 12000 || !/^[a-zA-Z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (value.v !== 1 || value.provider !== provider || value.username !== username || value.since !== since) throw new Error();
    if (provider === 'chesscom' && (!/^\d{4}\/(0[1-9]|1[0-2])$/.test(value.month) || !Number.isInteger(value.offset) || value.offset < 0 || value.offset > 200000)) throw new Error();
    if (provider === 'lichess' && (!Number.isSafeInteger(value.until) || value.until < 0 || !Array.isArray(value.ids) || value.ids.length > 200 || value.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9]{1,16}$/.test(id)))) throw new Error();
    return value;
  } catch { throw new ImportError('The import continuation is invalid. Start a new import.', 400); }
}

// Only fixed provider origins are contacted. Each request imports at most 100 games;
// clients follow the opaque cursor to build larger local libraries sequentially.
class PublicImporter {
  constructor({ fetchImpl = fetch, timeout = 45000, maxBytes = 20000000 } = {}) {
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.cooldown = 0;
    this.cache = new Map();
  }
  async request(url, accept, signal, cacheable = false) {
    const cached = this.cache.get(url);
    if (cacheable && cached && cached.expires > Date.now()) return cached.body;
    const response = await this.fetch(url, {
      signal, redirect: 'error',
      headers: { Accept: accept, 'User-Agent': 'Rookwise/2.0 (open source personal chess training)' },
    });
    if (response.status === 404) throw new ImportError('Public player or game history was not found. Check the platform and username.', 404);
    if (response.status === 429) {
      this.cooldown = Date.now() + 60000;
      throw new ImportError('The provider rate limited this import. Wait one minute, then resume.', 429);
    }
    if (!response.ok) throw new ImportError(`The provider could not complete this import (HTTP ${response.status}). You can resume or import a PGN file.`);
    if (Number(response.headers.get('content-length')) > this.maxBytes) throw new ImportError('This public monthly archive is too large. Download its PGN instead.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > this.maxBytes) throw new ImportError('This public monthly archive is too large. Download its PGN instead.');
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (cacheable) {
      if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(url, { body, expires: Date.now() + 300000 });
    }
    return body;
  }
  import({ provider, username, limit = 10, since = null, cursor = null } = {}) {
    let name, continuation;
    try {
      if (!['lichess', 'chesscom'].includes(provider)) throw new ImportError('Provider must be lichess or chesscom', 400);
      name = normalizeUsername(provider, username);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ImportError('Batch limit must be between 1 and 100 games', 400);
      if (since !== null && (!Number.isSafeInteger(since) || since < 0 || since > Date.now())) throw new ImportError('The start date must be a valid past timestamp in milliseconds', 400);
      continuation = decodeCursor(cursor, provider, name, since);
      if (Date.now() < this.cooldown) throw new ImportError('Wait one minute after the provider rate limit, then resume.', 429);
      if (this.pending >= 4) throw new ImportError('An import is already in progress. Please try again shortly.', 429);
    } catch(error) { return Promise.reject(error); }
    this.pending++;
    const task = this.queue.then(async () => {
      if (Date.now() < this.cooldown) throw new ImportError('Wait one minute after the provider rate limit, then resume.', 429);
      const signal = AbortSignal.timeout(this.timeout);
      try {
        const result = provider === 'lichess'
          ? await this.lichess(name, limit, since, continuation, signal)
          : await this.chesscom(name, limit, since, continuation, signal);
        return { ...result, provider, username: name };
      } catch(error) {
        if (error instanceof ImportError) throw error;
        if (signal.aborted) throw new ImportError('The public import timed out. Resume to retry this batch, or import a PGN file.', 504);
        throw new ImportError('The public provider could not be reached or returned invalid data. Resume to retry, or import a PGN file.');
      }
    }).finally(() => { this.pending--; });
    this.queue = task.catch(() => {});
    return task;
  }
  async lichess(name, limit, since, cursor, signal) {
    const url = new URL(`https://lichess.org/api/games/user/${name}`);
    const skip = new Set(cursor?.ids || []);
    const max = limit + skip.size;
    const params = { max: String(max), perfType: 'bullet,blitz,rapid,classical,correspondence,ultraBullet', ongoing: 'false', finished: 'true', pgnInJson: 'true', clocks: 'false', evals: 'false', opening: 'true', sort: 'dateDesc' };
    if (since !== null) params.since = String(since);
    if (cursor) params.until = String(cursor.until);
    url.search = new URLSearchParams(params);
    const body = await this.request(url.toString(), 'application/x-ndjson', signal);
    const records = body.trim() ? body.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const fresh = records.filter(record => !skip.has(record.id)).slice(0, limit);
    const games = [];
    for (const record of fresh) {
      if (typeof record.pgn !== 'string' || !Number.isSafeInteger(record.createdAt)) continue;
      if (since !== null && record.createdAt < since) continue;
      try {
        for (const game of importPgn(record.pgn)) games.push({ ...game, sourceId: `lichess:${record.id}`, playedAt: record.createdAt });
      } catch { /* Unparseable or unsupported games are skipped without losing pagination. */ }
    }
    const last = fresh.at(-1);
    let nextCursor = null;
    if (last && records.length >= max && Number.isSafeInteger(last.createdAt)) {
      const ids = [...new Set([...(cursor?.until === last.createdAt ? cursor.ids : []), ...fresh.filter(record => record.createdAt === last.createdAt).map(record => record.id)])];
      if (ids.length > 200) throw new ImportError('Too many games have the same timestamp. Import this history from a PGN file.');
      nextCursor = encodeCursor({ v:1, provider:'lichess', username:name, since, until:last.createdAt, ids });
    }
    return { games, nextCursor, done: nextCursor === null, notice: 'Finished standard games from the public Lichess API; unavailable or unsupported games are skipped.' };
  }
  async chesscom(name, limit, since, cursor, signal) {
    const base = `https://api.chess.com/pub/player/${name}/games`;
    const archiveData = JSON.parse(await this.request(`${base}/archives`, 'application/json', signal, true));
    if (!Array.isArray(archiveData.archives)) throw new ImportError('The provider returned an invalid archive list');
    const months = [...new Set(archiveData.archives.map(entry => {
      if (typeof entry !== 'string') return null;
      try {
        const archive = new URL(entry);
        if (archive.origin !== 'https://api.chess.com' || !archive.pathname.startsWith(`/pub/player/${name}/games/`)) return null;
        return archive.pathname.match(/\/(\d{4}\/(?:0[1-9]|1[0-2]))$/)?.[1] || null;
      } catch { return null; }
    }).filter(Boolean))].sort().reverse().filter(month => since === null || Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 1) > since);
    let index = cursor ? months.indexOf(cursor.month) : 0;
    if (index < 0) throw new ImportError('The archive list changed. Start a new import to refresh it.', 409);
    let offset = cursor?.offset || 0;
    let inspected = 0;
    const games = [];
    while (index < months.length && inspected < 4 && games.length < limit) {
      const month = months[index];
      const data = JSON.parse(await this.request(`${base}/${month}`, 'application/json', signal, true));
      if (!Array.isArray(data.games)) throw new ImportError('The provider returned an invalid monthly archive');
      const records = [...data.games].sort((a,b) => (Number(b.end_time)||0)-(Number(a.end_time)||0) || String(b.url||'').localeCompare(String(a.url||'')));
      while (offset < records.length && games.length < limit) {
        const record = records[offset++];
        if (record.rules !== 'chess' || typeof record.pgn !== 'string') continue;
        if (since !== null && (!Number.isFinite(record.end_time) || record.end_time * 1000 < since)) continue;
        try {
          for (const game of importPgn(record.pgn)) games.push({ ...game, sourceId: `chesscom:${record.url || `${month}:${offset}`}`, playedAt: Number(record.end_time)*1000 || null });
        } catch { /* Nonstandard or malformed PGN cannot become a training position. */ }
      }
      if (offset >= records.length) { index++; offset = 0; }
      inspected++;
    }
    const nextCursor = index < months.length ? encodeCursor({ v:1, provider:'chesscom', username:name, since, month:months[index], offset }) : null;
    return { games: games.slice(0,limit), nextCursor, done: nextCursor === null, notice: 'Public Chess.com monthly archives, newest first. Provider updates may be delayed; unsupported or invalid games are skipped.' };
  }
}
module.exports = { PublicImporter, ImportError, normalizeUsername };
