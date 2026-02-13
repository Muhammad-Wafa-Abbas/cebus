import { defineConfig } from 'tsup';

// Optional provider SDKs — must stay as real runtime import() calls,
// not bundled by esbuild, so they can be missing at runtime.
const optionalProviderSDKs = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@github/copilot-sdk',
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/google-genai',
  '@langchain/ollama',
];

export default defineConfig([
  // CLI entry point
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    target: 'node24',
    external: optionalProviderSDKs,
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
  },
  // Library entry point
  {
    entry: { 'index': 'src/index.ts' },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false, // Don't clean - CLI already built
    outDir: 'dist',
    target: 'node24',
    external: optionalProviderSDKs,
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
  },
  // Orchestration module entry point
  {
    entry: { 'orchestration/index': 'src/orchestration/index.ts' },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
    outDir: 'dist',
    target: 'node24',
    external: optionalProviderSDKs,
  },
]);
