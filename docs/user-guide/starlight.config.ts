/**
 * Astro Starlight sidebar configuration for Smallstore docs.
 *
 * Drop this into your Starlight astro.config.mjs:
 *
 * ```js
 * import { defineConfig } from 'astro/config';
 * import starlight from '@astrojs/starlight';
 *
 * export default defineConfig({
 *   integrations: [
 *     starlight({
 *       title: 'Smallstore',
 *       sidebar: sidebarConfig,
 *     }),
 *   ],
 * });
 * ```
 */

export const sidebarConfig = [
  {
    label: 'Getting Started',
    items: [
      { label: 'Introduction', link: '/' },
      { label: 'Getting Started', link: '/getting-started/' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { label: 'Adapters', link: '/adapters/' },
      { label: 'Presets', link: '/presets/' },
      { label: 'Routing', link: '/routing/' },
      { label: 'Environment Variables', link: '/env-vars/' },
    ],
  },
  {
    label: 'Features',
    items: [
      { label: 'Graph Store', link: '/graph-store/' },
      { label: 'Episodic Memory', link: '/episodic-memory/' },
      { label: 'Blob Middleware', link: '/blob-middleware/' },
      { label: 'Views & Materializers', link: '/views/' },
      { label: 'HTTP API', link: '/http-api/' },
      { label: 'Standalone Server', link: '/standalone-server/' },
      { label: 'Sync', link: '/sync/' },
    ],
  },
];
