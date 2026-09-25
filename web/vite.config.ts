import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { thirdPartyNotices } from "./scripts/third-party.mjs";

/**
 * Excalidraw 0.18.1 ships its command palette (⌘/) but does not export it, so a host
 * that doesn't render it gets a menu item and a shortcut that do nothing. Export it.
 * Fails the build if the package changes shape, instead of silently losing the palette.
 */
function exportCommandPalette(): Plugin {
  const definition =
    /[,;](\w+)=Object\.assign\(\w+=>\{let \w+=\w+\(\),\w+=\w+\(\);return \w+\(\(\)=>\{let \w+=\w+=>\{\w+\(\w+\)&&\(\w+\.preventDefault\(\),\w+\.stopPropagation\(\),\w+\(\w+=>\{let \w+=\w+\.openDialog\?\.name==="commandPalette"/;
  return {
    name: "export-excalidraw-command-palette",
    enforce: "pre",
    transform(code, id) {
      if (!/@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/]index\.js$/.test(id.split("?")[0])) return null;
      const match = definition.exec(code);
      if (!match) throw new Error("excalidraw: command palette component not found (package changed?)");
      return { code: `${code}\nexport { ${match[1]} as CommandPalette };\n`, map: null };
    },
  };
}

// Everything is bundled into dist/ and served by the Mac app from its own
// excalidraw:// URL scheme, so the app never needs the network.
export default defineConfig({
  base: "./",
  plugins: [exportCommandPalette(), react(), thirdPartyNotices()],
  optimizeDeps: {
    // the dev server's pre-bundling would skip the transform above
    exclude: ["@excalidraw/excalidraw"],
  },
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    target: "safari16",
    chunkSizeWarningLimit: 8000,
    assetsInlineLimit: 0,
  },
});
