const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { Server } = require('socket.io');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);

// Taille max d'un lot de points. socket.io plafonne a 1 Mo par defaut, soit
// ~16 000 points : au-dela le serveur FERME la connexion sans erreur applicative
// et le client boucle en reconnexion (symptome : l'app reste sur "connexion...",
// aucun point n'arrive). 400 000 points ~= 26 Mo.
// SCAN3D_MAX_BATCH_MB est le nom courant ; MAX_BATCH_MB reste accepte pour
// compatibilite avec la variable introduite en amont.
const MAX_BATCH_MB = Number(process.env.SCAN3D_MAX_BATCH_MB || process.env.MAX_BATCH_MB || 32);

// CORS restreint aux origines de SCAN3D_ORIGINS. Sans effet sur l'app Android :
// un client natif n'envoie pas d'en-tete Origin.
const io = new Server(server, {
  cors: { origin: auth.corsOrigin },
  maxHttpBufferSize: MAX_BATCH_MB * 1024 * 1024
});

const PORT = process.env.PORT || 3000;
// Derriere un reverse proxy, HOST=127.0.0.1 evite d'exposer le service au LAN.
const HOST = process.env.HOST || '0.0.0.0';

// Sonde de sante, volontairement hors du gate token.
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.use(auth.httpGuard);

// --- Sauvegardes de scenes (persistees dans sauv.json) ---------------------
// Fichier a la racine de scan3d ; surchargeable via SCAN3D_SAVES pour le placer
// dans shared/ et survivre aux redeploiements (le root est ecrase a chaque deploy).
// Un enregistrement : { id, name, thumb (dataURL JPEG leger), camera, voxel, count,
// points (base64 du format fil [uint32 n][float32 xyz][uint8 rgb]), createdAt, updatedAt }.
const SAVES_FILE = process.env.SCAN3D_SAVES || path.join(__dirname, 'sauv.json');

// Corps JSON volumineux : un nuage de voxels encode en base64 pese quelques Mo.
app.use(express.json({ limit: '96mb' }));

// Serialise les acces fichier (evite les read-modify-write concurrents).
let savesChain = Promise.resolve();
function withSaves(task) {
  const run = savesChain.then(task, task);
  savesChain = run.then(() => {}, () => {});
  return run;
}
async function readSaves() {
  try { return JSON.parse(await fsp.readFile(SAVES_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
const stripPoints = (s) => { const { points, ...rest } = s; return rest; };

// Liste (sans les points) : modale de chargement legere.
app.get('/api/saves', (_req, res) => withSaves(async () => {
  res.json((await readSaves()).map(stripPoints));
}).catch((e) => res.status(500).json({ error: String(e) })));

// Une sauvegarde complete (avec points) pour le chargement.
app.get('/api/saves/:id', (req, res) => withSaves(async () => {
  const s = (await readSaves()).find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'introuvable' });
  res.json(s);
}).catch((e) => res.status(500).json({ error: String(e) })));

// Cree, ou ECRASE si un id existant est fourni (scene chargee puis re-sauvegardee).
app.post('/api/saves', (req, res) => withSaves(async () => {
  const b = req.body || {};
  if (typeof b.points !== 'string' || !b.name) {
    return res.status(400).json({ error: 'name et points requis' });
  }
  const arr = await readSaves();
  const now = new Date().toISOString();
  const rec = {
    id: b.id || crypto.randomUUID(),
    name: String(b.name).slice(0, 120),
    thumb: typeof b.thumb === 'string' ? b.thumb : '',
    camera: b.camera || null,
    voxel: b.voxel || null,
    count: b.count | 0,
    points: b.points,
    createdAt: now,
    updatedAt: now,
  };
  const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) { rec.createdAt = arr[i].createdAt || now; arr[i] = rec; }
  else { arr.push(rec); }
  await fsp.writeFile(SAVES_FILE, JSON.stringify(arr), 'utf8');
  res.json(stripPoints(rec));
}).catch((e) => res.status(500).json({ error: String(e) })));

// Un seul asset a servir (three.js vient d'unpkg, socket.io.js est servi par
// socket.io lui-meme) : une route explicite plutot qu'express.static(__dirname),
// qui exposerait package.json, node_modules et le .env.local symlinke par le deploiement.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Telechargement de l'app Android depuis le telephone, sans cable ni adb.
// Le fichier vit dans shared/ : il survit aux deploiements et n'entre pas dans git.
// Protege par le meme token que la page (le gate est applique juste au-dessus).
app.get('/apk', (_req, res) => {
  const apk = process.env.SCAN3D_APK || '/home/jordi/scan3d/shared/scan3d.apk';
  res.type('application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="scan3d.apk"');
  res.sendFile(apk, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('APK absent');
  });
});

io.use(auth.socketGuard);

io.on('connection', (socket) => {
  // Seuls les clients porteurs du token rejoignent 'viewers' et RECOIVENT les
  // scans. Les emetteurs non authentifies (app dont l'URL est figee) peuvent
  // publier mais ne voient rien : la diffusion reste confidentielle.
  const authed = socket.data.authed === true;
  if (authed) socket.join('viewers');
  console.log('Client connecte :', socket.id, authed ? '[viewer authentifie]' : '[emetteur seul]',
    '- ua:', socket.handshake.headers['user-agent'] || '(aucun)');

  // Reception des donnees 3D -> rediffusion aux viewers authentifies (l'emetteur exclu).
  // Le 2e argument (ack) est un callback d'accuse de reception : on l'appelle une fois
  // le lot rediffuse, ce qui permet a l'app Android de marquer ces points comme "envoyes" (verts).
  socket.on('new_points', (data, ack) => {
    const n = Array.isArray(data) ? data.length : 0;
    socket.to('viewers').emit('draw_points', data);
    if (typeof ack === 'function') ack({ ok: true, count: n });
    console.log(`  lot recu de ${socket.id} : ${n} points -> ${io.sockets.adapter.rooms.get('viewers')?.size ?? 0} viewer(s)`);
  });

  // La raison est indispensable au diagnostic : un lot trop gros produit
  // "transport close" cote serveur, sans autre trace.
  socket.on('disconnect', (reason) =>
    console.log('Client deconnecte :', socket.id, '- raison:', reason));
});

server.listen(PORT, HOST, () => {
  console.log(`Serveur relais 3D a l'ecoute sur ${HOST}:${PORT}`);
});
