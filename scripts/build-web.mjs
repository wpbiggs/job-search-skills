import { build } from "esbuild";
await build({ entryPoints: ["src/web/app.ts"], outfile: "public/job-search/workspace/app.js", bundle: true, minify: true, format: "esm", target: "es2022" });
