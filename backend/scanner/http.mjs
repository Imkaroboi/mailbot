import http from 'node:http';
import { once } from 'node:events';
import { RequestError } from './auth.mjs';

export function createScannerServer({ allowedOrigins, verifyToken, createClient, scan, maxConnections = 8, maxPerAccount = 2, timeoutMs = 30 * 60_000 }) {
  if (!allowedOrigins.size) throw new Error('ALLOWED_ORIGINS must contain the public website origin.');
  const accounts = new Map(); const operations = new Set(); let verifying = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    const cors = origin && allowedOrigins.has(origin);
    if (cors) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.setHeader('Access-Control-Max-Age', '600');
    }
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method === 'GET' && request.url === '/health') {
      if (origin && !cors) { json(403, { error: 'Origin not allowed.' }); return; }
      json(200, { service: 'mailbot-cloud-gmail-reader', version: 1 }); return;
    }
    if (!cors) { json(403, { error: 'Origin not allowed.' }); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST' || request.url !== '/scan') { json(404, { error: 'Not found.' }); return; }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) { json(415, { error: 'Use JSON scan options.' }); return; }
    const authorization = request.headers.authorization || '';
    if (!/^Bearer [^\s]{1,8192}$/.test(authorization)) { json(401, { error: 'A Google access token is required.' }); return; }
    if (operations.size + verifying >= maxConnections) { response.setHeader('Retry-After', '15'); json(503, { error: 'The fast scanner is busy. Retry shortly.' }); return; }
    const controller = new AbortController(); let account = ''; let client; let registered = false; let verifyingNow = false;
    let timedOut = false;
    const close = () => { controller.abort(); client?.close(); };
    request.on('aborted', close); response.on('close', close);
    const deadline = setTimeout(() => { timedOut = true; close(); }, timeoutMs);
    deadline.unref();
    verifying++; verifyingNow = true;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) throw new RequestError(413, 'Scan options are too large.');
      }
      let options;
      try { options = JSON.parse(body || '{}'); } catch { throw new RequestError(400, 'Invalid scan options.'); }
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'sender')) throw new RequestError(400, 'Only a sender filter may be supplied.');
      if (options.sender !== undefined && (typeof options.sender !== 'string' || options.sender.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(options.sender))) throw new RequestError(400, 'Invalid sender address.');
      const authTimeout = AbortSignal.timeout(15_000);
      const token = authorization.slice(7);
      account = await verifyToken(token, AbortSignal.any([controller.signal, authTimeout]));
      verifying--; verifyingNow = false;
      if (controller.signal.aborted) throw new DOMException('Scan stopped', 'AbortError');
      if ((accounts.get(account) || 0) >= maxPerAccount) throw new RequestError(409, 'Two scans are already running for your account. Pause one before continuing.');
      accounts.set(account, (accounts.get(account) || 0) + 1); operations.add(controller); registered = true;
      // The account comes from Google's verified profile, never from user input.
      client = createClient(account, token);
      client.on?.('error', () => {});
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      const emit = async event => {
        if (response.destroyed || controller.signal.aborted) throw new DOMException('Scan stopped', 'AbortError');
        if (!response.write(`${JSON.stringify(event)}\n`)) await once(response, 'drain', { signal: controller.signal });
      };
      await emit({ type: 'progress', checked: 0, total: 0, indexed: 0, rate: 0 });
      const heartbeat = setInterval(() => { if (!response.destroyed && !controller.signal.aborted) response.write('{"type":"heartbeat"}\n'); }, 15_000);
      heartbeat.unref();
      try { await scan(client, emit, controller.signal, { sender: options.sender }); }
      finally { clearInterval(heartbeat); }
    } catch (error) {
      if (!response.destroyed) {
        const message = timedOut ? 'The scan reached its time limit. Saved headers are kept; resume to continue.' : error instanceof RequestError ? error.message : error?.authenticationFailed ? 'Google did not allow the fast mail connection. Reconnect Google and approve fast scanning.' : 'The fast scan stopped. Saved headers are kept; check your connection and resume.';
        if (response.headersSent) response.write(`${JSON.stringify({ type: 'error', message })}\n`);
        else json(error instanceof RequestError ? error.status : 502, { error: message });
      }
    } finally {
      clearTimeout(deadline);
      if (verifyingNow) verifying--;
      if (registered) {
        operations.delete(controller); const count = (accounts.get(account) || 1) - 1;
        if (count) accounts.set(account, count); else accounts.delete(account);
      }
      request.removeListener('aborted', close); response.removeListener('close', close);
      controller.abort(); client?.close(); if (!response.destroyed) response.end();
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('close', () => { for (const controller of operations) controller.abort(); });
  return server;
}
