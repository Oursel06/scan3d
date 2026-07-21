const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS "*" pour autoriser la connexion WebSocket entrante depuis l'app Android
const io = new Server(server, {
  cors: { origin: '*' }
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

  socket.on('disconnect', () => console.log('Client deconnecte :', socket.id));
});

// Ecoute sur 0.0.0.0 (indispensable pour Render)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur relais 3D a l'ecoute sur le port ${PORT}`);
});
