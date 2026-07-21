#!/usr/bin/env node
// Test E2E scan3d. Verifie le modele d'acces reel :
//   - la PAGE web est protegee par le token (401 sans lui) ;
//   - un client sans token peut EMETTRE (app dont l'URL est figee) mais ne
//     RECOIT rien : les scans ne sortent que vers les viewers authentifies ;
//   - le relais new_points -> draw_points fonctionne app -> viewer.
// En mode strict (SCAN3D_OPEN_INGEST absent), le client sans token est refuse :
// le test s'adapte et verifie ce comportement a la place.
//
// Usage : SCAN3D_TOKEN=xxx node tools/e2e.js [url] [--polling]
const { io } = require('socket.io-client');
const https = require('https');
const http = require('http');

const URL_ = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : 'https://scan3d.cube3d.fr';
const TOKEN = process.env.SCAN3D_TOKEN;
const TRANSPORTS = process.argv.includes('--polling') ? ['polling'] : ['websocket'];
if (!TOKEN) { console.error('SCAN3D_TOKEN manquant'); process.exit(2); }

const ok = (m) => console.log('  OK   ' + m);
const ko = (m) => { console.error('  FAIL ' + m); process.exitCode = 1; };

function status(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0));
  });
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const s = io(URL_, { transports: TRANSPORTS, auth, reconnection: false, timeout: 15000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => { s.close(); reject(e); });
  });
}

// Resout avec les donnees recues, ou null apres ms.
function waitDraw(sock, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    sock.on('draw_points', (d) => { clearTimeout(t); resolve(d); });
  });
}

(async () => {
  console.log(`> cible ${URL_} (transport: ${TRANSPORTS.join(',')})`);

  console.log('[1] la page web exige le token');
  const nu = await status(URL_ + '/');
  const avec = await status(URL_ + '/?k=' + encodeURIComponent(TOKEN));
  nu === 401 ? ok('sans token -> 401') : ko('sans token -> ' + nu + ' (401 attendu)');
  avec === 200 ? ok('avec token -> 200') : ko('avec token -> ' + avec + ' (200 attendu)');

  console.log('[2] client SANS token');
  let anon = null;
  try {
    anon = await connect({});
    ok('admis comme emetteur (mode ingestion ouverte)');
  } catch (e) {
    if (e.message === 'unauthorized') {
      ok('refuse (mode strict) — fin des tests, pas d\'ingestion ouverte a verifier');
      console.log(process.exitCode ? '> ECHEC' : '> TOUT OK');
      process.exit(process.exitCode || 0);
    }
    ko('erreur inattendue : ' + e.message);
    process.exit(1);
  }

  console.log('[3] confidentialite : un client sans token ne recoit AUCUN scan');
  const viewer = await connect({ token: TOKEN });
  ok('viewer authentifie connecte');

  const vGot = waitDraw(viewer, 6000);
  const aGot = waitDraw(anon, 6000);       // l'anonyme ne doit rien voir passer

  const payload = [{ x: 0.1, y: 0.2, z: 0.3, r: 255, g: 0, b: 0 }];
  const emitter = await connect({});        // joue le role de l'app Android
  const ack = await new Promise((res) => emitter.emit('new_points', payload, res));
  ack && ack.ok ? ok(`emission acceptee (ack count=${ack.count})`) : ko("pas d'ack");

  const [v, a] = await Promise.all([vGot, aGot]);
  v ? ok('le viewer authentifie A RECU le scan')
    : ko("le viewer n'a rien recu");
  a === null ? ok("le client sans token n'a RIEN recu — confidentialite preservee")
    : ko('!!! FUITE : un client sans token a recu ' + JSON.stringify(a).slice(0, 60));

  viewer.close(); anon.close(); emitter.close();
  console.log(process.exitCode ? '> ECHEC' : '> TOUT OK');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
