// Static output only, no adapter. trailingSlash follows the majority of live URLs in capture/.
import { defineConfig } from 'astro/config';
import { contentLinkNormalization } from './scripts/lib/normalize-content-links.mjs';

export default defineConfig({
  site: '{{ORIGIN}}',
  output: 'static',
  trailingSlash: '{{TRAILING}}',
  build: { format: '{{FORMAT}}' },
  integrations: [contentLinkNormalization('{{HOSTING}}')],
});
