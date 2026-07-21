#!/usr/bin/env node
// Test E2E scan3d : refus sans token / avec mauvais token, puis relais
// new_points -> draw_points entre deux clients. Remplace l'app Android.
//
// Usage : SCAN3D_TOKEN=xxx node tools/e2e.js [url] [--polling]
const { io } = require('socket.io-client');

const URL_ = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : 'https://scan3d.cube3d.fr';
const TOKEN = process.env.SCAN3D_TOKEN;
const TRANSPORTS = process.argv.includes('--polling') ? ['polling'] : ['websocket'];
if (!TOKEN) { console.error('SCAN3D_TOKEN manquant'); process.exit(2); }

const ok = (m) => console.log('  OK   ' + m);
const ko = (m) => { console.error('  FAIL ' + m); process.exitCode = 1; };

function connect(auth, transports) {
  return new Promise((resolve, reject) => {
    const s = io(URL_, { transports, auth, reconnection: false, timeout: 8000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => { s.close(); reject(e); });
  });
}

(async () => {
  console.log(`> cible ${URL_} (transport: ${TRANSPORTS.join(',')})`);

  console.log('[1] handshake SANS token -> doit etre refuse');
  try {
    const s = await connect({}, TRANSPORTS); s.close();
    ko('connexion acceptee sans token !');
  } catch (e) {
    e.message === 'unauthorized' ? ok('refuse (' + e.message + ')')
      : ko('erreur inattendue : ' + e.message);
  }

  console.log('[2] handshake avec MAUVAIS token -> doit etre refuse');
  try {
    const s = await connect({ token: 'x'.repeat(TOKEN.length) }, TRANSPORTS); s.close();
    ko('mauvais token accepte !');
  } catch (e) {
    e.message === 'unauthorized' ? ok('refuse') : ko('erreur inattendue : ' + e.message);
  }

  console.log('[3] relais new_points -> draw_points entre 2 clients');
  const [emit, recv] = await Promise.all([
    connect({ token: TOKEN }, TRANSPORTS),
    connect({ token: TOKEN }, TRANSPORTS),
  ]);
  ok('2 clients connectes (' + emit.io.engine.transport.name + ')');

  const payload = [{ x: 0.1, y: 0.2, z: 0.3, r: 255, g: 0, b: 0 }];
  const got = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout draw_points')), 5000);
    recv.on('draw_points', (d) => { clearTimeout(t); res(d); });
  });

  const ack = await new Promise((res) => emit.emit('new_points', payload, res));
  ack && ack.ok ? ok('ack recu du serveur') : ko("pas d'ack");
  try {
    const d = await got;
    ok('draw_points recu : ' + JSON.stringify(d).slice(0, 80));
  } catch (e) { ko(e.message); }

  emit.close(); recv.close();
  console.log(process.exitCode ? '> ECHEC' : '> TOUT OK');
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
