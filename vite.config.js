import { defineConfig, loadEnv } from 'vite';
import { companionApi } from './server/api-plugin.js';

export default defineConfig(({ mode }) => {
  // Load every var (no prefix filter) so the API keys stay server-side only.
  // They are deliberately NOT exposed via import.meta.env to client code.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [companionApi(env)],
    server: {
      port: 5180,
      // Loopback only: the dev server proxies paid keys and the memory file.
      // Tailscale reaches it through `tailscale serve`, which proxies to this
      // loopback address, so the app itself is never bound to a network
      // interface and is unreachable from the home LAN.
      host: '127.0.0.1',
      /**
       * Hosts Vite will answer for, which is a DNS-rebinding guard and NOT an
       * access control.
       *
       * Tailscale's HTTPS proxy forwards with `Host: cyborg-kali.tailffab08.ts.net`,
       * which is not localhost, so Vite refused every request from the phone
       * with "Blocked request. This host is not allowed." The app code was fine;
       * the guard did not know about the tunnel.
       *
       * Scoped to this tailnet on purpose. Setting `true` or `'.ts.net'` would
       * disable the guard entirely, and this server holds her memory file.
       * If the PC is renamed or the tailnet changes, update the suffix.
       */
      allowedHosts: [
        'cyborg-kali.tailffab08.ts.net',
        '.tailffab08.ts.net',
      ],
      open: true,
      watch: {
        /**
         * Three directories that are inside the project root but are NOT app
         * source. Each one was measured, and each cost something real:
         *
         *  - `voice/.venv-kokoro` is 27,447 files: a full PyTorch install. The
         *    watcher was indexing all of it — 27,533 file handles, 425 MB of
         *    RAM, and 78% of a core burnt while the server served nothing. This
         *    is the big one, and it is why the dev server appeared to "stop
         *    working when idle": it was never idle, it was crawling.
         *  - `data/memory.json` is rewritten on EVERY turn, so an unignored
         *    watcher reloaded the page mid-conversation.
         *  - `dist` is build output; watching it just causes reload churn.
         *
         * This is NOT the same as ignoring `public/models`, which the note
         * below warns about. That one stopped Vite from SERVING files it had
         * not yet seen, because the models are copied in after startup. None of
         * these three is served as a static asset at all: `data/` is read
         * server-side by the plugin, `dist` is only read after a build, and the
         * venv is Python's business entirely.
         */
        ignored: [
          '**/data/**',
          '**/logs/**',
          '**/dist/**',
          '**/build/**',
          '**/release/**',
          '**/public/models/**',
          '**/voice/.venv*/**',
          '**/node_modules/**',
        ],
      },
      // NOTE: do not add `watch.ignored` for public/models here. It does stop the
      // EBUSY crash while a large .fbx is being copied in, but it also makes
      // Vite stop serving any file under public/models that was not already
      // present when the server started - the prop silently 404s into the SPA
      // fallback and the loader dies parsing "<!doctype" as JSON.
    },
    build: {
      target: 'es2022',
      assetsInlineLimit: 0,
      rollupOptions: {
        output: {
          // three.js is ~85% of the bundle and never changes between app edits,
          // so it gets its own long-lived chunk.
          manualChunks: {
            three: ['three'],
          },
        },
      },
    },
  };
});
