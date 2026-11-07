import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the built game works wherever it's hosted
  // (GitHub Pages serves it from /<repo-name>/, not the site root)
  base: './',
});
