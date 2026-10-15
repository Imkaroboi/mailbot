import { ImapFlow } from 'imapflow';
import { createScannerServer } from './http.mjs';
import { tokenVerifier } from './auth.mjs';
import { scanImapHeaders } from './reader.mjs';

const values = name => new Set((process.env[name] || '').split(',').map(value => value.trim()).filter(Boolean));
const server = createScannerServer({
  allowedOrigins: values('ALLOWED_ORIGINS'),
  verifyToken: tokenVerifier(values('GOOGLE_CLIENT_IDS')),
  createClient: (email, token) => new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false, logRaw: false,
    auth: { user: email, accessToken: token },
    clientInfo: { name: 'Mailbot hosted header reader', version: '1.1' },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 90_000, disableAutoIdle: true,
  }),
  scan: scanImapHeaders,
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Mailbot scanner ready.'));
const shutdown = () => { server.close(); server.closeAllConnections(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
