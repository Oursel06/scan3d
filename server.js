const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Taille max d'un lot de points. socket.io plafonne a 1 Mo par defaut, soit
// ~16 000 points : au-dela le serveur FERME la connexion sans erreur applicative
// et le client boucle en reconnexion (symptome : l'app reste sur "connexion...",
// aucun point n'arrive). 400 000 points ~= 26 Mo.
const MAX_BATCH_MB = Number(process.env.MAX_BATCH_MB || 32);

// CORS "*" pour autoriser la connexion WebSocket entrante depuis l'app Android
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: MAX_BATCH_MB * 1024 * 1024
});

const PORT = process.env.PORT || 3000;

// Sert les fichiers statiques de la PWA (index.html) depuis la racine
app.use(express.static(__dirname));

io.on('connection', (socket) => {
  console.log('Client connecte :', socket.id);

  // Reception des donnees 3D -> broadcast immediat a tous les AUTRES clients.
  // Le 2e argument (ack) est un callback d'accuse de reception : on l'appelle une fois
  // le lot rediffuse, ce qui permet a l'app Android de marquer ces points comme "envoyes" (verts).
  socket.on('new_points', (data, ack) => {
    socket.broadcast.emit('draw_points', data);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // La raison est indispensable au diagnostic : un lot trop gros se traduit par
  // un "transport close" et n'a sinon aucune trace cote serveur.
  socket.on('disconnect', (reason) =>
    console.log('Client deconnecte :', socket.id, '- raison:', reason));
});

// Ecoute sur 0.0.0.0 (indispensable pour Render)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur relais 3D a l'ecoute sur le port ${PORT}`);
});
