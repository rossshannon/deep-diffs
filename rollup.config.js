import { nodeResolve } from '@rollup/plugin-node-resolve';
import { copyFileSync, mkdirSync } from 'fs';

// Plugin to copy TypeScript definitions
const copyTypes = () => ({
  name: 'copy-types',
  buildEnd() {
    mkdirSync('dist', { recursive: true });
    copyFileSync('src/deep-diff.d.ts', 'dist/deep-diff.d.ts');
  }
});

export default {
  input: 'src/deep-diff.js',
  output: [
    {
      file: 'dist/deep-diff.js',
      format: 'es',
      sourcemap: true
    },
    {
      file: 'dist/deep-diff.cjs',
      format: 'cjs',
      sourcemap: true,
      exports: 'named'
    }
  ],
  plugins: [
    nodeResolve(),
    copyTypes()
  ],
  external: ['diff-match-patch']
};
