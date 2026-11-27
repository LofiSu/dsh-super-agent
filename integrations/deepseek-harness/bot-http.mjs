import { Readable } from 'node:stream';
import { createBotRoutes } from './bot-routes.mjs';

/** Adapt the Fetch route to the desktop host's Node HTTP listener. */
export function createBotHttpHandler(options) {
  const route = createBotRoutes(options);
  return async function handleBots(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/bots' && !url.pathname.startsWith('/api/bots/')) return false;
    const init = { method: req.method, headers: req.headers };
    if (req.method === 'POST') {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const response = await route(new Request(url, init));
    if (!response) return false;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return true;
  };
}
