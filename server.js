const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);

// CORS restreint aux origines de SCAN3D_ORIGINS. Sans effet sur l'app Android :
// un client natif n'envoie pas d'en-tete Origin.
const io = new Server(server, {
  cors: { origin: auth.corsOrigin }
});

const PORT = process.env.PORT || 3000;
// Derriere un reverse proxy, HOST=127.0.0.1 evite d'exposer le service au LAN.
const HOST = process.env.HOST || '0.0.0.0';

// Sonde de sante, volontairement hors du gate token.
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.use(auth.httpGuard);

// Un seul asset a servir (three.js vient d'unpkg, socket.io.js est servi par
// socket.io lui-meme) : une route explicite plutot qu'express.static(__dirname),
// qui exposerait package.json, node_modules et le .env.local symlinke par le deploiement.
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.use(auth.socketGuard);

io.on('connection', (socket) => {
  console.log('Client connecte :', socket.id);

  // Reception des donnees 3D -> broadcast immediat a tous les AUTRES clients.
  // Le 2e argument (ack) est un callback d'accuse de reception : on l'appelle une fois
  // le lot rediffuse, ce qui permet a l'app Android de marquer ces points comme "envoyes" (verts).
  socket.on('new_points', (data, ack) => {
    socket.broadcast.emit('draw_points', data);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => console.log('Client deconnecte :', socket.id));
});

server.listen(PORT, HOST, () => {
  console.log(`Serveur relais 3D a l'ecoute sur ${HOST}:${PORT}`);
});
