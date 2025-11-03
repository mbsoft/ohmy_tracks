const WebSocket = require('ws');

// Create a WebSocket server
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', ws => {
  console.log('Client connected');

  // Send a welcome message
  ws.send(JSON.stringify({ message: 'Connected to WebSocket server' }));

  // Handle messages from client
  ws.on('message', message => {
    console.log('Received:', message);
  });

  // Handle client disconnect
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

module.exports = wss;
