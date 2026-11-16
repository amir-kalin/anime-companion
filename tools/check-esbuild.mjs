// Smoke test: confirm esbuild's native binary is usable (its postinstall was
// blocked on this machine, and Vite silently fails to start without it).
import { transform } from 'esbuild';

try {
  const r = await transform('const a = 1;', { loader: 'js' });
  console.log('esbuild native OK ->', r.code.trim());
} catch (e) {
  console.log('esbuild native BROKEN ->', String(e.message).split('\n')[0]);
  process.exitCode = 1;
}
