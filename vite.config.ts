import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./extension/manifest.json";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function readLocalEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;
  const content = readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !line.trim().startsWith("#")) {
      env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return env;
}

const localEnv = readLocalEnv(fromRoot("./.env.local"));

export default defineConfig({
  root: fromRoot("./extension"),
  // Keys live in .env.local at the repo root. Only code that reads
  // import.meta.env.ELEVENLABS_API_KEY / GEMINI_API_KEY gets them inlined; that
  // must stay limited to the offscreen document and the background service
  // worker, never a content script or a page a website can reach.
  envDir: fromRoot("."),
  envPrefix: ["VITE_", "ELEVENLABS_", "GEMINI_"],
  define: {
    ...(localEnv.ELEVENLABS_API_KEY
      ? { "import.meta.env.ELEVENLABS_API_KEY": JSON.stringify(localEnv.ELEVENLABS_API_KEY) }
      : {}),
    ...(localEnv.GEMINI_API_KEY
      ? { "import.meta.env.GEMINI_API_KEY": JSON.stringify(localEnv.GEMINI_API_KEY) }
      : {}),
  },
  resolve: { alias: { "@": fromRoot("./extension/src/ui") } },
  plugins: [react(), tailwindcss(), crx({ manifest })],
  build: {
    outDir: fromRoot("./dist"),
    emptyOutDir: true,
    // Vite's preloading adds <link> tags to the document. For the content script
    // that document is the website, which must not get extension links added to it.
    modulePreload: false,
    rollupOptions: {
      // Pages the manifest does not mention still need to be built.
      input: {
        offscreen: fromRoot("./extension/offscreen.html"),
        permission: fromRoot("./extension/permission.html"),
      },
    },
  },
});
