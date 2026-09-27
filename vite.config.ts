import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export default defineConfig({
  plugins: [react(), {
    name: "compressed-assets",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const entry of Object.values(bundle)) {
          if (!/\.(js|css|svg|json)$/.test(entry.fileName)) continue;
          const source = Buffer.from(entry.type === "chunk" ? entry.code : entry.source);
          if (source.length < 1024) continue;
          const compressed = {
            br: brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
            gz: gzipSync(source, { level: 9 }),
          };
          for (const [extension, data] of Object.entries(compressed)) {
            if (data.length < source.length) this.emitFile({ type: "asset", fileName: `${entry.fileName}.${extension}`, source: data });
          }
        }
      },
    },
  }],
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: Number(process.env.CITROPY_UI_PORT ?? 5177),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.CITROPY_PORT ?? (process.env.CITROPY_DEVELOPMENT === "1" ? 4178 : 4177)}`,
      "/socket": {
        target: `ws://127.0.0.1:${process.env.CITROPY_PORT ?? (process.env.CITROPY_DEVELOPMENT === "1" ? 4178 : 4177)}`,
        ws: true,
      },
    },
  },
});
