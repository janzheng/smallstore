/**
 * Build script for npm package using dnt (Deno to Node Transform)
 *
 * Produces dual ESM + CJS builds in dist/
 *
 * Usage:
 *   deno run -A scripts/build-npm.ts
 *
 * What it does:
 * 1. Cleans dist/
 * 2. Transforms Deno TypeScript → Node-compatible JS
 * 3. Rewrites jsr:/npm: imports to bare specifiers
 * 4. Generates .d.ts type declarations
 * 5. Outputs ESM (dist/esm/) and CJS (dist/cjs/)
 *
 * Note: Some adapters have Deno-specific deps (SQLite, local file, vault-graph).
 * These are shimmed or excluded in the npm build.
 * Cloud adapters (Upstash, Airtable, Notion, CF, R2) work everywhere.
 */

import { build, emptyDir } from "jsr:@deno/dnt@^0.41.3";

const outDir = "./dist";

await emptyDir(outDir);

await build({
  entryPoints: [
    // Main entry
    { name: ".", path: "./mod.ts" },
    // Subpath exports
    { name: "./factory-slim", path: "./src/factory-slim.ts" },
    { name: "./presets", path: "./presets.ts" },
    { name: "./config", path: "./config.ts" },
    { name: "./search", path: "./src/search/mod.ts" },
    { name: "./graph", path: "./src/graph/mod.ts" },
    { name: "./episodic", path: "./src/episodic/mod.ts" },
    { name: "./disclosure", path: "./src/disclosure/mod.ts" },
    { name: "./blob-middleware", path: "./src/blob-middleware/mod.ts" },
    { name: "./views", path: "./src/views/mod.ts" },
    { name: "./materializers", path: "./src/materializers/mod.ts" },
    { name: "./messaging", path: "./src/messaging/mod.ts" },
    { name: "./messaging/types", path: "./src/messaging/types.ts" },
    { name: "./peers", path: "./src/peers/mod.ts" },
    { name: "./peers/types", path: "./src/peers/types.ts" },
    { name: "./http", path: "./src/http/mod.ts" },
    { name: "./sync", path: "./src/sync.ts" },
    // CF adapters as standalone subpaths so Worker code can `import { ... } from 'smallstore/adapters/cloudflare-d1'`
    { name: "./adapters/memory", path: "./src/adapters/memory.ts" },
    { name: "./adapters/cloudflare-d1", path: "./src/adapters/cloudflare-d1.ts" },
    { name: "./adapters/cloudflare-r2", path: "./src/adapters/cloudflare-r2.ts" },
    { name: "./adapters/cloudflare-kv", path: "./src/adapters/cloudflare-kv.ts" },
    { name: "./adapters/cloudflare-do", path: "./src/adapters/cloudflare-do.ts" },
  ],
  outDir,
  // ESM only — CJS not supported due to top-level await in dependencies (e.g., @db/sqlite)
  scriptModule: false,
  // Deno shim disabled: it uses `__dirname` which breaks in Cloudflare Workers
  // ESM bundles. Source code that calls `Deno.*` (e.g., middleware cleanup
  // timers, env reads) will fail at runtime in Node — guard with `typeof Deno`
  // checks if you need cross-runtime support. The Worker entry only loads
  // adapters + messaging that don't touch Deno APIs, so this is safe.
  shims: {
    deno: false,
  },
  package: {
    name: "@yawnxyz/smallstore",
    version: "0.2.0",
    description: "Universal storage layer — one API, 17+ backends.",
    license: "MIT",
    author: "Jan Zheng",
    repository: {
      type: "git",
      url: "https://github.com/janzheng/smallstore",
    },
    engines: {
      node: ">=18.0.0",
    },
    dependencies: {
      // None at module level — every adapter SDK is now an optional peer
      // dep, lazy-loaded on first use with a helpful "install X" error
      // if missing. dnt auto-adds anything from the import map to
      // `dependencies`; the postBuild hook below strips those entries so
      // npm sees only the peerDeps placement.
    },
    peerDependencies: {
      "hono": ">=4.0.0",
      "postal-mime": ">=2.0.0",
      "fast-xml-parser": ">=4.5.0",
      // aws-sdk: r2-direct adapter + blob-middleware r2-direct backend.
      "@aws-sdk/client-s3": ">=3.0.0",
      "@aws-sdk/s3-request-presigner": ">=3.0.0",
      // Notion: notion adapter + src/clients/notion/notionModern.
      "@notionhq/client": ">=5.0.0",
      // unstorage: unstorage adapter (upstash + cloudflare-kv/r2 driver wrappers).
      "unstorage": ">=1.0.0",
    },
    peerDependenciesMeta: {
      "hono": { optional: true },
      "postal-mime": { optional: true },
      "fast-xml-parser": { optional: true },
      "@aws-sdk/client-s3": { optional: true },
      "@aws-sdk/s3-request-presigner": { optional: true },
      "@notionhq/client": { optional: true },
      "unstorage": { optional: true },
    },
    optionalDependencies: {
      "@zvec/zvec": "^0.2.1",
    },
  },
  // importMap resolves bare specifiers in deno.json to these npm: URLs
  // dnt needs mappings for BOTH the resolved import map specifiers AND
  // any direct npm: specifiers used in source files
  importMap: "./deno.json",
  mappings: {
    // Specifier strings MUST exactly match the values in deno.json's "imports".
    // dnt resolves bare specifiers via the import map, then applies these
    // mappings to rewrite the result to npm package refs.
    "npm:hono@^4.10.3": {
      name: "hono",
      version: "^4.0.0",
    },
    "npm:@notionhq/client@^5.16.0": {
      name: "@notionhq/client",
      version: "^5.16.0",
    },
    "npm:@aws-sdk/client-s3@^3.0.0": {
      name: "@aws-sdk/client-s3",
      version: "^3.0.0",
    },
    "npm:@aws-sdk/s3-request-presigner@^3.0.0": {
      name: "@aws-sdk/s3-request-presigner",
      version: "^3.0.0",
    },
    "npm:unstorage@^1.17.0": {
      name: "unstorage",
      version: "^1.17.0",
    },
    "npm:postal-mime@^2.4.4": {
      name: "postal-mime",
      version: "^2.4.4",
    },
    "npm:fast-xml-parser@^4.5.0": {
      name: "fast-xml-parser",
      version: "^4.5.0",
    },
  },
  // Don't run tests during build
  test: false,
  // Type check the output
  typeCheck: false,
  // Declaration files
  declaration: "separate",
  // Suppress errors from Deno-specific modules
  filterDiagnostic(diagnostic) {
    const fileName = diagnostic.file?.fileName || '';
    // Skip Deno-only adapter errors (sqlite, local-file, local-json, deno-fs, obsidian, vault-graph)
    if (
      fileName.includes('sqlite') ||
      fileName.includes('local-file') ||
      fileName.includes('local-json') ||
      fileName.includes('deno-fs') ||
      fileName.includes('obsidian') ||
      fileName.includes('vault-graph')
    ) {
      return false;
    }
    return true;
  },
  compilerOptions: {
    lib: ["ES2022", "DOM"],
    target: "ES2022",
  },
  async postBuild() {
    // Fix package.json: move hono to peerDependencies, zvec to optionalDependencies
    const pkgPath = `${outDir}/package.json`;
    const pkg = JSON.parse(await Deno.readTextFile(pkgPath));

    // Remove hono from dependencies (it's a peer dep)
    delete pkg.dependencies?.["hono"];

    // Remove postal-mime from dependencies (it's an optional peer — only needed by cf-email channel)
    delete pkg.dependencies?.["postal-mime"];

    // Remove fast-xml-parser from dependencies (it's an optional peer — only needed by rss channel)
    delete pkg.dependencies?.["fast-xml-parser"];

    // Remove aws-sdk packages from dependencies (optional peer — only needed
    // by the r2-direct adapter / blob-middleware r2-direct backend; both
    // lazy-load via `await import` and throw a helpful install error).
    delete pkg.dependencies?.["@aws-sdk/client-s3"];
    delete pkg.dependencies?.["@aws-sdk/s3-request-presigner"];

    // Remove @notionhq/client from dependencies (optional peer — only needed
    // by the notion adapter + clients/notion/notionModern; lazy-loaded on
    // first NotionModernClient method call).
    delete pkg.dependencies?.["@notionhq/client"];

    // Remove unstorage from dependencies (optional peer — only needed by
    // the unstorage adapter; lazy-loaded inside createUnstorageInstance).
    delete pkg.dependencies?.["unstorage"];

    // Remove @zvec/zvec from dependencies, keep in optionalDependencies
    delete pkg.dependencies?.["@zvec/zvec"];

    await Deno.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    // Copy README and LICENSE
    try {
      await Deno.copyFile("README.md", `${outDir}/README.md`);
    } catch {
      // README may not exist yet
    }
    try {
      await Deno.copyFile("LICENSE", `${outDir}/LICENSE`);
    } catch {
      // LICENSE may not exist yet
    }
    console.log("\n✅ npm build complete!");
    console.log(`   ESM: ${outDir}/esm/`);
    console.log(`   Types: ${outDir}/types/`);
    console.log("\n📦 To publish:");
    console.log(`   cd ${outDir} && npm publish`);
  },
});
