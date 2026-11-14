const { importPgn } = require('./pgn-import');

class ImportError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Public provider endpoints only. No account credentials or caller-supplied URLs are accepted.
class PublicImporter {
  constructor({ fetchImpl = fetch, timeout = 25000, maxBytes = 5000000 } = {}) {
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.cooldown = 0;
  }

  async request(url, accept, signal) {
    const response = await this.fetch(url, {
      signal, redirect: 'error',
      headers: { Accept: accept, 'User-Agent': 'ChessAI-local/1.0 (personal chess training)' },
    });
    if (response.status === 404) throw new ImportError('Public player or game history was not found', 404);
    if (response.status === 429) {
      this.cooldown = Date.now() + 60000;
      throw new ImportError('The provider rate limited this import. Wait one minute and try again.', 429);
    }
    if (!response.ok) throw new ImportError(`The provider could not complete this import (HTTP ${response.status})`);
    if (Number(response.headers.get('content-length')) > this.maxBytes) throw new ImportError('This public archive is too large. Download a smaller PGN instead.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > this.maxBytes) throw new ImportError('This public archive is too large. Download a smaller PGN instead.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  import({ provider, username, limit = 10 } = {}) {
    if (!['lichess', 'chesscom'].includes(provider)) return Promise.reject(new ImportError('Provider must be lichess or chesscom', 400));
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{2,30}$/.test(username)) return Promise.reject(new ImportError('Enter a valid public username (2–30 letters, numbers, underscores, or hyphens)', 400));
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return Promise.reject(new ImportError('Import limit must be between 1 and 20 games', 400));
    if (Date.now() < this.cooldown) return Promise.reject(new ImportError('Wait one minute after the provider rate limit before importing again.', 429));
    if (this.pending >= 4) return Promise.reject(new ImportError('An import is already in progress. Please try again shortly.', 429));
    this.pending += 1;
    const task = this.queue.then(async () => {
      if (Date.now() < this.cooldown) throw new ImportError('Wait one minute after the provider rate limit before importing again.', 429);
      const signal = AbortSignal.timeout(this.timeout);
      try {
        const name = username.toLowerCase();
        let games = [];
        let notice;
        if (provider === 'lichess') {
          const url = new URL(`https://lichess.org/api/games/user/${name}`);
          url.search = new URLSearchParams({ max: String(limit), perfType: 'bullet,blitz,rapid,classical,correspondence,ultraBullet', ongoing: 'false', finished: 'true', clocks: 'false', evals: 'false', opening: 'true' });
          const pgn = await this.request(url.toString(), 'application/x-chess-pgn', signal);
          games = pgn.trim() ? importPgn(pgn) : [];
          notice = 'Imported recent finished standard games from the public Lichess API.';
        } else {
          const base = `https://api.chess.com/pub/player/${name}/games`;
          const archiveData = JSON.parse(await this.request(base + '/archives', 'application/json', signal));
          if (!Array.isArray(archiveData.archives)) throw new ImportError('The provider returned an invalid archive list');
          const months = archiveData.archives.map((entry) => typeof entry === 'string' && entry.match(/\/(\d{4})\/(0[1-9]|1[0-2])$/)).filter(Boolean).slice(-3).reverse();
          for (const month of months) {
            // Reconstruct each URL from a fixed origin and validated year/month.
            const data = JSON.parse(await this.request(`${base}/${month[1]}/${month[2]}`, 'application/json', signal));
            if (!Array.isArray(data.games)) throw new ImportError('The provider returned an invalid game archive');
            for (const game of [...data.games].reverse()) {
              if (game.rules !== 'chess' || typeof game.pgn !== 'string') continue;
              try { games.push(...importPgn(game.pgn)); } catch { continue; }
              if (games.length >= limit) break;
            }
            if (games.length >= limit) break;
          }
          notice = 'Imported recent standard games from up to three latest played months. Chess.com public archives may be delayed.';
        }
        return { games: games.slice(0, limit), provider, username, notice };
      } catch (error) {
        if (error instanceof ImportError) throw error;
        if (signal.aborted) throw new ImportError('The public import timed out. Try fewer games or import a PGN file.', 504);
        throw new ImportError('The public provider could not be reached or returned invalid game data. Try a PGN file.');
      }
    }).finally(() => { this.pending -= 1; });
    this.queue = task.catch(() => {});
    return task;
  }
}

module.exports = { PublicImporter, ImportError };
