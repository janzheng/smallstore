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
    { name: "./presets", path: "./presets.ts" },
    { name: "./config", path: "./config.ts" },
    { name: "./search", path: "./src/search/mod.ts" },
    { name: "./graph", path: "./src/graph/mod.ts" },
    { name: "./episodic", path: "./src/episodic/mod.ts" },
    { name: "./disclosure", path: "./src/disclosure/mod.ts" },
    { name: "./blob-middleware", path: "./src/blob-middleware/mod.ts" },
    { name: "./views", path: "./src/views/mod.ts" },
    { name: "./materializers", path: "./src/materializers/mod.ts" },
    { name: "./http", path: "./src/http/mod.ts" },
    { name: "./sync", path: "./src/sync.ts" },
  ],
  outDir,
  // ESM only — CJS not supported due to top-level await in dependencies (e.g., @db/sqlite)
  scriptModule: false,
  shims: {
    deno: true,
  },
  package: {
    name: "smallstore",
    version: "0.1.0",
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
      "@notionhq/client": "^2.3.0",
      "@aws-sdk/client-s3": "^3.0.0",
      "@aws-sdk/s3-request-presigner": "^3.0.0",
      "unstorage": "^1.17.0",
    },
    peerDependencies: {
      "hono": ">=4.0.0",
    },
    peerDependenciesMeta: {
      "hono": { optional: true },
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
    // Direct npm: specifiers used in source files
    // These must match the npm: specifiers used directly in source files
    // (as opposed to bare imports resolved via deno.json import map)
    "npm:hono@^4.10.3": {
      name: "hono",
      version: "^4.10.3",
    },
    "npm:@notionhq/client@^2.0.0": {
      name: "@notionhq/client",
      version: "^2.3.0",
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
