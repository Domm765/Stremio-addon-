const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const fs = require('fs');
const path = require('path');

const KEY = process.env.TMDB_API_KEY;
if (!KEY) {
  console.error('Missing TMDB_API_KEY. Get a free key at https://www.themoviedb.org/settings/api');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogs.json'), 'utf8'));

const manifest = {
  id: 'community.my.catalogues',
  version: '1.4.0',
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

// ---------- Catalog handler ----------
const pageCache = new Map();
const TTL = 60 * 60 * 1000;

async function buildCatalog(cat, page) {
  const params = { page, language: 'en-US', include_adult: 'false' };
  for (const [k, v] of Object.entries(cat.query)) params[k] = fill(v);
  if (cat.keywordNames) {
    const ids = (await Promise.all(cat.keywordNames.map(keywordId))).filter(Boolean);
    if (ids.length) params.with_keywords = ids.join(',');
  }
  const { results } = await tmdb(`/discover/${cat.endpoint}`, params);
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
  return metas.filter(Boolean);
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const cat = cfg.catalogs.find(c => c.id === id && c.type === type);
  if (!cat) return { metas: [] };
  const page = Math.floor(Number((extra && extra.skip) || 0) / 20) + 1;
  const key = `${id}:${page}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.t < TTL) return { metas: hit.metas, cacheMaxAge: 3600 };
  try {
    const metas = await buildCatalog(cat, page);
    pageCache.set(key, { t: Date.now(), metas });
    return { metas, cacheMaxAge: 3600 };
  } catch (e) {
    console.error(e.message);
    return { metas: hit ? hit.metas : [] };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
