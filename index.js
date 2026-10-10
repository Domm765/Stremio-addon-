const http = require('http');
const fs = require('fs');
const path = require('path');

const KEY = process.env.TMDB_API_KEY;
if (!KEY) {
  console.error('Missing TMDB_API_KEY. Get a free key at https://www.themoviedb.org/settings/api');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogs.json'), 'utf8'));

// drop incomplete entries and repeated ids
{
  const seenIds = new Set();
  cfg.catalogs = cfg.catalogs.filter(c => {
    const key = c && c.type + ':' + c.id;
    if (!c || !c.id || !c.type || !c.name || seenIds.has(key)) return false;
    seenIds.add(key);
    return true;
  });
}

const manifest = {
  id: 'community.my.catalogues.v2',
  version: '2.0.0',
  name: 'My 30 Catalogues',
  description: 'New releases, comedy, classics, collections and brand hubs',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: cfg.catalogs.map(c => ({
    type: c.type,
    id: c.id,
    name: c.name,
