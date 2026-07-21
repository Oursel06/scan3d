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

  // Reception des donnees 3D -> broadcast immediat a tous les AUTRES clients
  socket.on('new_points', (data) => {
    socket.broadcast.emit('draw_points', data);
  });

  socket.on('disconnect', () => console.log('Client deconnecte :', socket.id));
});

// Ecoute sur 0.0.0.0 (indispensable pour Render)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur relais 3D a l'ecoute sur le port ${PORT}`);
});
