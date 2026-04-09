'use strict';

function setupWebSocket(wss, redis, logger) {
  const clients = new Set();

  wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).slice(2);
    ws.clientId = clientId;
    ws.isAlive = true;
    clients.add(ws);
    logger.info({ clientId }, 'WebSocket client connected');

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'subscribe') ws.subscriptions = msg.targets || [];
      } catch {}
    });
    ws.on('close', () => { clients.delete(ws); });
    ws.send(JSON.stringify({ type: 'connected', clientId }));
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  function broadcast(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach((ws) => {
      if (ws.readyState === 1) ws.send(data);
    });
  }

  // Called after Redis is connected
  function subscribeToRedis() {
    redis.subscribe('job:updates', (msg) => {
      try { broadcast(JSON.parse(msg)); } catch {}
    });
    redis.subscribe('worker:updates', (msg) => {
      try { broadcast(JSON.parse(msg)); } catch {}
    });
  }

  return { broadcast, subscribeToRedis };
}

module.exports = { setupWebSocket };
