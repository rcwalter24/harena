import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

/** Commit of the build, so a kit can be matched to the site it came with ("dev" outside git). */
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

const stamp = `${new Date().toISOString().slice(0, 10)} ${commit()}`;

/**
 * The single-file test kit: src/sim/cli.ts with the engine, maps and built-in bots bundled into
 * dist/harena-sim.mjs (Node built-ins stay external). Runs after the site build.
 */
export default defineConfig({
  define: { __HARENA_BUILD__: JSON.stringify(stamp) },
  build: {
    ssr: 'src/sim/cli.ts',
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node18',
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'harena-sim.mjs',
        codeSplitting: false,
        banner: `#!/usr/bin/env node\n// Harena test kit (build ${stamp}). Run: node harena-sim.mjs --help\n// MIT License.`,
      },
    },
  },
  ssr: { noExternal: true },
});
