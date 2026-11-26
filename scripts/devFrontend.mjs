import { createServer } from 'vite';

export async function devFrontend(root, backendPort, listenPort) {
  const target = `http://127.0.0.1:${backendPort}`;
  const vite = await createServer({
    root,
    server: {
      host: '127.0.0.1',
      port: listenPort,
      strictPort: true,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (upstream, request) => {
              const expected = request.headers.host ? 'http://' + request.headers.host : null;
              if (request.headers.origin === expected) upstream.setHeader('Origin', target);
            });
          },
        },
      },
    },
  });
  try {
    await vite.listen();
    return { port: vite.httpServer.address().port, close: () => vite.close() };
  } catch (error) {
    await vite.close();
    throw error;
  }
}
