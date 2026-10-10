const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fs = require('fs');
const path = require('path');

const KEY = process.env.TMDB_API_KEY;
if (!KEY) {
  console.error('Missing TMDB_API_KEY. Get a free key at https://www.themoviedb.org/settings/api');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogs.json'), 'utf8'));

// Extra catalogue files (catalogs-2.json, catalogs-3.json, ...) are merged in automatically
for (const f of fs.readdirSync(__dirname).filter(n => /^catalogs-.+\.json$/.test(n)).sort()) {
  const extra = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  cfg.catalogs.push(...(extra.catalogs || []));
}

const manifest = {
  id: 'community.my.catalogues',
  version: '1.8.0',
  name: 'My Catalogues',
  description: 'Streaming, digital releases and comedy catalogues',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: cfg.catalogs.map(c => ({
    type: c.type,
    id: c.id,
    name: c.name,
    extra: [{ name: 'skip' }]
  }))
};

// ---------- TMDB helpers ----------
async function tmdb(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  const headers = {};
  if (KEY.length > 40) headers.Authorization = `Bearer ${KEY}`; // v4 token
  else url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${endpoint}`);
  return res.json();
}

function dateStr(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function fill(value) {
  return String(value)
    .replace('{{today}}', dateStr(0))
    .replace(/\{\{daysAgo:(\d+)\}\}/g, (_, n) => dateStr(Number(n)))
    .replace(/\{\{daysAhead:(\d+)\}\}/g, (_, n) => dateStr(-Number(n)))
    .replace('{{region}}', cfg.region)
    .replace('{{providers}}', cfg.providers.join('|'));
}

const keywordCache = new Map();
async function keywordId(name) {
  if (keywordCache.has(name)) return keywordCache.get(name);
  let id = null;
  try {
    const { results } = await tmdb('/search/keyword', { query: name });
    const hit = results.find(r => r.name.toLowerCase() === name.toLowerCase()) || results[0];
    id = hit ? hit.id : null;
  } catch (e) {
    console.error('Keyword lookup failed:', name);
  }
  keywordCache.set(name, id);
  return id;
}

const imdbCache = new Map();
async function imdbId(endpoint, tmdbId) {
  const key = `${endpoint}:${tmdbId}`;
  if (imdbCache.has(key)) return imdbCache.get(key);
  let id = null;
  try {
    const data = await tmdb(`/${endpoint}/${tmdbId}/external_ids`);
    id = data.imdb_id || null;
  } catch (e) {}
  imdbCache.set(key, id);
  return id;
}

// ---------- Curated lists: "Title|year" entries are looked up on TMDB ----------
const titleCache = new Map();
async function resolveTitle(cat, spec) {
  const key = `${cat.endpoint}:${spec}`;
  if (titleCache.has(key)) return titleCache.get(key);
  const [title, year] = spec.split('|');
  const params = { query: title, language: 'en-US', include_adult: 'false' };
  if (year) params[cat.endpoint === 'movie' ? 'year' : 'first_air_date_year'] = year;
  let hit = null;
  try {
    const { results } = await tmdb(`/search/${cat.endpoint}`, params);
    hit = (results && results[0]) || null;
  } catch (e) {
    console.error('Title lookup failed:', spec);
  }
  titleCache.set(key, hit);
  return hit;
}

// ---------- Franchises: collections are looked up by name, films in release order ----------
const collectionCache = new Map();
async function collectionMovies(cat) {
  if (collectionCache.has(cat.id)) return collectionCache.get(cat.id);
  const groups = await Promise.all(cat.collectionNames.map(async name => {
    try {
      const { results } = await tmdb('/search/collection', { query: name, language: 'en-US' });
      const hit = results.find(r => r.name.toLowerCase() === name.toLowerCase()) || results[0];
      if (!hit) return [];
      const col = await tmdb(`/collection/${hit.id}`, { language: 'en-US' });
      return (col.parts || [])
        .slice()
        .sort((a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999'));
    } catch (e) {
      console.error('Collection lookup failed:', name);
      return [];
    }
  }));
  const seen = new Set();
  const all = groups.flat().filter(m => !seen.has(m.id) && seen.add(m.id));
  collectionCache.set(cat.id, all);
  return all;
}

// ---------- Brand resolver: finds a network / company ID from TMDB itself ----------
// A catalogue can list "anchor" titles that definitely belong to a brand. The addon reads the
// anchor's networks (series) or production companies (movies) and keeps the ID whose name matches exactly.
const brandCache = new Map();
async function resolveBrandId(spec) {
  const key = spec.kind + ':' + spec.names.join('|');
  if (brandCache.has(key)) return brandCache.get(key);
  const type = spec.kind === 'network' ? 'tv' : 'movie';
  const field = spec.kind === 'network' ? 'networks' : 'production_companies';
  const wanted = spec.names.map(n => n.toLowerCase());
  let found = null;
  for (const anchor of spec.anchors) {
    try {
      const [title, year] = anchor.split('|');
      const params = { query: title, language: 'en-US', include_adult: 'false' };
      if (year) params[type === 'movie' ? 'year' : 'first_air_date_year'] = year;
      const { results } = await tmdb('/search/' + type, params);
      const hit = results && results[0];
      if (!hit) continue;
      const detail = await tmdb('/' + type + '/' + hit.id, { language: 'en-US' });
      const match = (detail[field] || []).find(x => wanted.includes(String(x.name).toLowerCase()));
      if (match) { found = match.id; break; }
    } catch (e) {
      console.error('Brand lookup failed:', spec.names[0]);
    }
  }
  if (found) brandCache.set(key, found); // failures are not remembered, so they retry next time
  return found;
}

// ---------- Catalog handler ----------
const pageCache = new Map();
const TTL = 60 * 60 * 1000;
const PAGE_SIZE = 20;

async function getResults(cat, page) {
  if (cat.titles) {
    const slice = cat.titles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const hits = await Promise.all(slice.map(t => resolveTitle(cat, t)));
    return hits.filter(Boolean);
  }
  if (cat.collectionNames) {
    const all = await collectionMovies(cat);
    return all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }
  const params = { page, language: 'en-US', include_adult: 'false' };
  for (const [k, v] of Object.entries(cat.query || {})) params[k] = fill(v);
  if (cat.resolve) {
    const found = {};
    for (const spec of cat.resolve) {
      const id = await resolveBrandId(spec);
      if (id) (found[spec.param] = found[spec.param] || []).push(id);
    }
    // brand could not be identified: show nothing rather than unrelated titles
    if (!Object.keys(found).length) return [];
    for (const [p, ids] of Object.entries(found)) params[p] = [params[p], ...ids].filter(Boolean).join('|');
  }
  if (cat.keywordNames) {
    const ids = (await Promise.all(cat.keywordNames.map(keywordId))).filter(Boolean);
    if (ids.length) params.with_keywords = ids.join(',');
    else if (cat.strict) return []; // never show an unfiltered list for a keyword-only row
  }
  const data = await tmdb(cat.path || `/discover/${cat.endpoint}`, params);
  return data.results || [];
}

async function buildCatalog(cat, page) {
  const results = await getResults(cat, page);
  const metas = await Promise.all(
    results.map(async r => {
      const id = await imdbId(cat.endpoint, r.id);
      if (!id) return null;
      const date = r.release_date || r.first_air_date || '';
      return {
        id,
        type: cat.type,
        name: r.title || r.name,
        poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : undefined,
        background: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : undefined,
        description: r.overview,
        releaseInfo: date.slice(0, 4)
      };
    })
  );
  const seen = new Set();
  return metas.filter(m => m && !seen.has(m.id) && seen.add(m.id));
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const cat = cfg.catalogs.find(c => c.id === id && c.type === type);
  if (!cat) return { metas: [] };
  const page = Math.floor(Number((extra && extra.skip) || 0) / PAGE_SIZE) + 1;
  const key = `${id}:${page}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return { metas: hit.metas, cacheMaxAge: 3600 };
  try {
    const metas = await buildCatalog(cat, page);
    if (metas.length) pageCache.set(key, { t: Date.now(), metas });
    return { metas, cacheMaxAge: 3600 };
  } catch (e) {
    console.error(e.message);
    return { metas: hit ? hit.metas : [] };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
