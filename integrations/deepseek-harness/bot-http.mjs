import { Readable } from 'node:stream';
import { createBotRoutes } from './bot-routes.mjs';

/** Adapt the Fetch route to the desktop host's Node HTTP listener. */
export function createBotHttpHandler(options) {
  const route = createBotRoutes(options);
  return async function handleBots(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const offerPath = /^\/api\/bots\/offers(?:\/[a-f0-9-]{36}\/decision)?$/.test(url.pathname);
    const cancelPath = /^\/api\/bots\/teams\/[a-f0-9-]{36}\/dispatch\/[a-z0-9-]{1,80}\/cancel$/i.test(url.pathname);
    if (!cancelPath && !offerPath && url.pathname !== '/api/bots' && url.pathname !== '/api/bots/devices' && url.pathname !== '/api/bots/teams' && !/^\/api\/bots\/teams\/[a-f0-9-]{36}\/dispatch$/.test(url.pathname) && !/^\/api\/bots\/devices\/device-[a-f0-9-]{36}\/probe$/.test(url.pathname) && !/^\/api\/bots\/[a-f0-9-]{36}\/(?:turns|avatar)$/.test(url.pathname)) return false;
    const init = { method: req.method, headers: req.headers };
    if (req.method === 'POST') {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const response = await route(new Request(url, init));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return true;
  };
}
