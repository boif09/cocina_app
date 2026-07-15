const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (_error) { /* npm install todavía no ejecutado */ }

const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'config.json');
const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function normalizeBasePath(value) {
  const raw = String(value || '/cocina').trim();
  if (raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

const configuredDbPath = process.env.DATABASE_PATH || fileConfig.database?.path || './data/cocina.db';

module.exports = {
  rootDir,
  port: Number(process.env.PORT || fileConfig.app?.port || 3002),
  basePath: normalizeBasePath(process.env.BASE_PATH || fileConfig.app?.basePath),
  databasePath: path.isAbsolute(configuredDbPath)
    ? configuredDbPath
    : path.resolve(rootDir, configuredDbPath)
};
