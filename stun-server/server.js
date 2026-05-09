require('dotenv').config();
const Turn = require('node-turn');
const os = require('os');

const PORT     = parseInt(process.env.STUN_PORT || '3478');
const RELAY    = process.env.RELAY_IP || detectLocalIP();
const REALM    = process.env.STUN_REALM || 'ionik.local';
const USERNAME = process.env.STUN_USERNAME || 'ionikuser';
const PASSWORD = process.env.STUN_PASSWORD || 'ionikturn123';
const MIN_PORT = parseInt(process.env.RELAY_MIN_PORT || '49160');
const MAX_PORT = parseInt(process.env.RELAY_MAX_PORT || '49200');

function detectLocalIP() {
  for (const iface of Object.values(os.networkInterfaces()))
    for (const a of iface)
      if (!a.internal && a.family === 'IPv4' && !a.address.startsWith('172.'))
        return a.address;
  return '0.0.0.0';
}

const server = new Turn({
  authMech: 'none',
  realm: REALM,
  listeningPort: PORT,
  listeningIps: ['0.0.0.0'],
  relayIps: [RELAY],
  externalIps: RELAY,
  minPort: MIN_PORT,
  maxPort: MAX_PORT,
  debugLevel: 'INFO',
  debug: (level, msg) => console.log(`[${level}] ${msg}`),
});

server.start();
console.log('=== ionik TURN (node-turn) ===');
console.log(`Port      : ${PORT} UDP/TCP`);
console.log(`Relay IP  : ${RELAY}`);
console.log(`Relay port: ${MIN_PORT}-${MAX_PORT}`);
console.log(`Realm     : ${REALM}`);
console.log(`User      : ${USERNAME} / ${PASSWORD}`);
