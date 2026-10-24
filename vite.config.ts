/// <reference types="vitest/config" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Development-only: POST /__dev/save-export?name=… writes the request body to ./.exports so
 * files rendered in the browser can be inspected with ffprobe. Never part of a build.
 */
function devExportSink(): Plugin {
  return {
    name: 'beatform-dev-export-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/save-export', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const name = new URL(req.url ?? '', 'http://dev').searchParams.get('name') ?? '';
        if (!/^[\w.-]{1,120}$/.test(name) || name.startsWith('.')) {
          res.statusCode = 400;
          res.end('bad name');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = resolve(server.config.root, '.exports');
          mkdirSync(dir, { recursive: true });
          const body = Buffer.concat(chunks);
          writeFileSync(resolve(dir, name), body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, bytes: body.length }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devExportSink()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
