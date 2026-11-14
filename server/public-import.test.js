const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicImporter, normalizeUsername } = require('./public-import');
const PGN = '[Event "Public game"]\n[White "Player"]\n[Black "Rival"]\n[Result "*"]\n\n1. e4 e5 *';
const archive = (id,time=1794000000) => ({rules:'chess',pgn:PGN,url:`https://www.chess.com/game/live/${id}`,end_time:time});
const lichess = (id,time=1794000000000) => ({id,createdAt:time,pgn:PGN});
const jsonLines = records => new Response(records.map(record=>JSON.stringify(record)).join('\n'));

test('normalizes @ names and correct platform profile URLs; refuses arbitrary URLs', () => {
  assert.equal(normalizeUsername('chesscom',' https://www.chess.com/member/Hikaru/ '),'hikaru');
  assert.equal(normalizeUsername('lichess','lichess.org/@/Thibault'),'thibault');
  assert.equal(normalizeUsername('lichess','@Player'),'player');
  for(const value of ['https://evil.invalid/player','https://lichess.org/@/player','../player']) assert.throws(()=>normalizeUsername('chesscom',value));
});

test('Lichess fixed-origin NDJSON batches honor dates and continue without timestamp-boundary duplicates', async () => {
  const calls=[];
  const importer=new PublicImporter({fetchImpl:async(url,options)=>{
    const parsed=new URL(url);calls.push(parsed);
    assert.equal(parsed.origin,'https://lichess.org');
    assert.equal(parsed.pathname,'/api/games/user/player');
    assert.equal(parsed.searchParams.get('ongoing'),'false');
    assert.equal(parsed.searchParams.get('pgnInJson'),'true');
    assert.equal(parsed.searchParams.get('since'),'1700000000000');
    assert.equal(options.headers.Accept,'application/x-ndjson');
    assert.equal(options.redirect,'error');
    if(calls.length===1)return jsonLines([lichess('gameAAAA',1794000000000),lichess('gameBBBB',1793000000000)]);
    assert.equal(parsed.searchParams.get('until'),'1793000000000');
    assert.equal(parsed.searchParams.get('max'),'3');
    return jsonLines([lichess('gameBBBB',1793000000000),lichess('gameCCCC',1793000000000),lichess('gameDDDD',1792000000000)]);
  }});
  const first=await importer.import({provider:'lichess',username:'@Player',limit:2,since:1700000000000});
  assert.equal(first.games.length,2);assert.ok(first.nextCursor);
  const second=await importer.import({provider:'lichess',username:'Player',limit:2,since:1700000000000,cursor:first.nextCursor});
  assert.deepEqual(second.games.map(game=>game.sourceId),['lichess:gameCCCC','lichess:gameDDDD']);
});

test('Chess.com paginates an entire month then walks older archives and caches monthly responses', async()=>{
  const calls=[];
  const importer=new PublicImporter({fetchImpl:async url=>{
    calls.push(url);
    if(url.endsWith('/archives'))return Response.json({archives:['https://api.chess.com/pub/player/player/games/2026/08','https://malicious.invalid/path/2026/09','https://api.chess.com/pub/player/player/games/2026/10','https://api.chess.com/pub/player/player/games/2026/11']});
    if(url.endsWith('/2026/11'))return Response.json({games:[archive('1',1794000000),archive('3',1796000000),archive('2',1795000000)]});
    if(url.endsWith('/2026/10'))return Response.json({games:[archive('0',1790000000)]});
    return Response.json({games:[]});
  }});
  const one=await importer.import({provider:'chesscom',username:'https://www.chess.com/member/Player',limit:2});
  assert.deepEqual(one.games.map(game=>game.sourceId),['chesscom:https://www.chess.com/game/live/3','chesscom:https://www.chess.com/game/live/2']);
  const two=await importer.import({provider:'chesscom',username:'Player',limit:2,cursor:one.nextCursor});
  assert.equal(two.games[0].sourceId,'chesscom:https://www.chess.com/game/live/1');
  assert.equal(two.games[1].sourceId,'chesscom:https://www.chess.com/game/live/0');
  assert.equal(calls.filter(url=>url.endsWith('/2026/11')).length,1);
  assert.ok(calls.every(url=>url.startsWith('https://api.chess.com/')));
});

test('Chess.com date filtering avoids old months and excludes old games inside the cutoff month',async()=>{
  const cutoff=Date.UTC(2026,10,7);
  const importer=new PublicImporter({fetchImpl:async url=>{
    if(url.endsWith('/archives'))return Response.json({archives:['https://api.chess.com/pub/player/player/games/2026/09','https://api.chess.com/pub/player/player/games/2026/11']});
    assert.ok(url.endsWith('/2026/11'));
    return Response.json({games:[archive('old',(cutoff-1000)/1000),archive('new',(cutoff+1000)/1000)]});
  }});
  const result=await importer.import({provider:'chesscom',username:'Player',limit:100,since:cutoff});
  assert.equal(result.games.length,1);assert.match(result.games[0].sourceId,/new$/);assert.equal(result.done,true);
});

test('bounded batches can assemble more than one thousand games without duplication',async()=>{
  const records=Array.from({length:1105},(_,i)=>archive(String(i),1796000000-i));
  const importer=new PublicImporter({fetchImpl:async url=>url.endsWith('/archives') ? Response.json({archives:['https://api.chess.com/pub/player/player/games/2026/11']}) : Response.json({games:records})});
  let cursor=null;const ids=[];
  do {const result=await importer.import({provider:'chesscom',username:'Player',limit:100,cursor});ids.push(...result.games.map(game=>game.sourceId));cursor=result.nextCursor;}while(cursor);
  assert.equal(ids.length,1105);assert.equal(new Set(ids).size,1105);
});

test('invalid limits dates cursors and identity changes fail before network access',async()=>{
  const importer=new PublicImporter({fetchImpl:()=>{throw new Error('Must not fetch');}});
  for(const args of [{provider:'other',username:'Player'},{provider:'lichess',username:'https://evil.invalid/'},{provider:'chesscom',username:'Player',limit:101},{provider:'lichess',username:'Player',since:-1},{provider:'lichess',username:'Player',cursor:'garbage'}])await assert.rejects(importer.import(args),error=>error.status===400);
});

test('rate limits apply cooldown and network requests remain serial',async()=>{
  let calls=0;
  const limited=new PublicImporter({fetchImpl:async()=>{calls++;return new Response('',{status:429});}});
  await assert.rejects(limited.import({provider:'lichess',username:'Player'}),error=>error.status===429);
  await assert.rejects(limited.import({provider:'lichess',username:'Player'}),error=>error.status===429);
  assert.equal(calls,1);
  let active=0,maxActive=0;
  const serial=new PublicImporter({fetchImpl:async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return jsonLines([lichess('one')]);}});
  await Promise.all([serial.import({provider:'lichess',username:'Player'}),serial.import({provider:'lichess',username:'Other'})]);
  assert.equal(maxActive,1);
});

test('missing accounts and oversized streams report clear errors',async()=>{
  const missing=new PublicImporter({fetchImpl:async()=>new Response('',{status:404})});
  await assert.rejects(missing.import({provider:'lichess',username:'Nobody'}),error=>error.status===404);
  const large=new PublicImporter({maxBytes:20,fetchImpl:async()=>new Response(PGN)});
  await assert.rejects(large.import({provider:'lichess',username:'Player'}),/too large/);
});
