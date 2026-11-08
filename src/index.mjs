import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { BridgeManager } from './manager.mjs';
import { createHttpServer } from './server.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8090);
const password = process.env.VOLTRA_PASSWORD ?? '';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (!password && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('VOLTRA_PASSWORD must be set when binding outside localhost');
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manager = new BridgeManager(resolve(process.env.CONFIG_PATH ?? join(root, 'data/bridges.json')));
await manager.load();
const server = createHttpServer({
  manager, user: process.env.VOLTRA_USER ?? 'admin', password, publicDir: join(root, 'public')
});
server.listen(port, host, () => console.log('Voltra Standalone: http://' + host + ':' + port));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
