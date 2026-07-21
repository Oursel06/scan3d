'use strict';
// Gate par token partage : protege l'acces a la page ET le handshake socket.io.
// Isole dans ce fichier pour garder server.js quasi identique a l'upstream
// (Oursel06/scan3d) et rendre les merges triviaux.
const crypto = require('crypto');

const TOKEN = (process.env.SCAN3D_TOKEN || '').trim();
if (!TOKEN) {
  console.error('[scan3d] SCAN3D_TOKEN absent ou vide — refus de demarrer.');
  process.exit(1); // fail-closed : jamais de service ouvert par accident
}
const TOKEN_BUF = Buffer.from(TOKEN, 'utf8');
const COOKIE = 'scan3d_k';

// Mode "ingestion ouverte" : accepte les clients SANS token, mais uniquement
// comme EMETTEURS. Ils ne rejoignent pas la room 'viewers' et ne recoivent donc
// aucun scan (cf. server.js). Necessaire pour une app dont l'URL est figee dans
// le binaire et qui ne peut transmettre aucun token.
const OPEN_INGEST = /^(1|true|oui|yes)$/i.test(process.env.SCAN3D_OPEN_INGEST || '');

// CORS socket.io : ne concerne que les clients navigateur. Un client natif
// (app Android) n'envoie pas d'en-tete Origin et n'est donc pas affecte.
const ORIGINS = (process.env.SCAN3D_ORIGINS || 'https://scan3d.cube3d.fr')
  .split(',').map((s) => s.trim()).filter(Boolean);
const corsOrigin = ORIGINS.includes('*') ? '*' : ORIGINS;

function tokenOk(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const buf = Buffer.from(candidate, 'utf8');
  if (buf.length !== TOKEN_BUF.length) return false; // timingSafeEqual exige l'egalite de longueur
  return crypto.timingSafeEqual(buf, TOKEN_BUF);
}

function fromBearer(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

function fromCookie(header) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== COOKIE) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
  }
  return null;
}

// Middleware Express : gate tout ce qui suit.
function httpGuard(req, res, next) {
  const url = new URL(req.url, 'http://localhost');
  const t = url.searchParams.get('k')
    || url.searchParams.get('token')
    || req.headers['x-scan3d-token']
    || fromBearer(req.headers.authorization)
    || fromCookie(req.headers.cookie);

  if (!tokenOk(t)) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('text/plain; charset=utf-8')
      .send("401 - token requis : ajoute ?k=<token> a l'URL");
  }

  // Memorise le token pour pouvoir recharger la page sans ?k= dans l'URL.
  // Volontairement lisible en JS (pas httpOnly) : index.html en a besoin
  // pour io({ auth: { token } }) apres un F5 sans query string.
  const https = req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE, t, {
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000,
    sameSite: 'lax',
    secure: https,
    httpOnly: false,
  });
  next();
}

// Middleware socket.io : s'execute AVANT l'evenement 'connection', donc avant
// que le client puisse emettre quoi que ce soit.
function socketGuard(socket, next) {
  const h = socket.handshake;
  const t = (h.auth && h.auth.token)                  // client moderne (JS, socket.io-client-java 2.x)
    || (h.query && (h.query.k || h.query.token))      // repli query string (socket.io-client-java 1.x)
    || h.headers['x-scan3d-token']
    || fromBearer(h.headers.authorization)
    || fromCookie(h.headers.cookie);

  // authed pilote l'appartenance a la room 'viewers' : seuls les clients
  // authentifies RECOIVENT les scans (cf. server.js).
  if (tokenOk(t)) {
    socket.data.authed = true;
    return next();
  }

  // Le User-Agent distingue l'app Android du navigateur : indispensable au
  // diagnostic, l'IP etant toujours celle du reverse proxy.
  const ua = h.headers['user-agent'] || '(aucun)';

  if (OPEN_INGEST) {
    socket.data.authed = false;
    console.warn('[scan3d] emetteur SANS token admis (ingestion ouverte) — ua=%s', ua);
    return next();
  }

  console.warn('[scan3d] handshake REFUSE — ua=%s | jamais de token dans auth/query/cookie', ua);
  const err = new Error('unauthorized');
  err.data = { code: 'AUTH_REQUIRED' };
  next(err); // -> connect_error cote client, fermeture propre, PAS de reconnexion en boucle
}

module.exports = { tokenOk, httpGuard, socketGuard, corsOrigin };
