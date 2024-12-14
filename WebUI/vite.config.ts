import { defineConfig } from 'vite';
import path from "path";
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite';
import electron from "vite-plugin-electron";
import pkg from "./package.json";
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const assetParrentArray = [
  { parttern: /.(jpe?g|a?png)$/, folder: "image" },
  { parttern: /.css$/, folder: "css" },
  { parttern: /.svg$/, folder: "icons" },
  { parttern: /.js$/, folder: "js" },
  { parttern: /.(mp4|mov|ts|flv|avi|mkv|rmvb)$/, folder: "video" },
  { parttern: /.(mp3|aac|wav|flac)$/, folder: "audio" },
  { parttern: /.(ttf|woff|woff2|otf|eot)$/, folder: "font" },
];

function findAssetFolder(ext: string) {
  for (let i = 0; i < assetParrentArray.length; i++) {
    const item = assetParrentArray[i];
    if (item.parttern.test(ext)) {
      return item.folder;
    }
  }
  return ext.replace(".", "");
}


// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isServe = command === "serve";
  const isBuild = command === "build";
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG;
  const dependenciesToBeTranspiled = ['get-port'];
  return {
    css: {
      postcss: {
        plugins: [tailwind(), autoprefixer()],
      },
    },
    plugins: [
      vue(),
      AutoImport({
        imports: ["vue"],
        dts: "src/auto-import.d.ts",
      }),
      electron([
        {
          // Main-Process entry file of the Electron App.
          entry: "electron/main.ts",
          onstart(options) {
            if (process.env.VSCODE_DEBUG) {
              console.log(
                /* For `.vscode/.debug.script.mjs` */ "[startup] Electron App"
              );
            } else {
              options.startup();
            }
          },
          vite: {
            build: {
              sourcemap,
              minify: isBuild,
              outDir: "dist/main",
              rollupOptions: {
                external: Object.keys(
                  "dependencies" in pkg ? pkg.dependencies : {}
                ).filter((d) => !dependenciesToBeTranspiled.includes(d)),
              },
            },
          },
        },
        {
          entry: "electron/preload.ts",
          onstart(options) {
            // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete,
            // instead of restarting the entire Electron App.
            options.reload();
          },
          vite: {
            build: {
              sourcemap: sourcemap ? "inline" : undefined, // #332
              minify: isBuild,
              outDir: "dist/preload",
              rollupOptions: {
                external: Object.keys(
                  "dependencies" in pkg ? pkg.dependencies : {}
                ),
              },
            },
          },
        },
      ]),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 25413,
      proxy: {
        "^/api/":{
          changeOrigin: true,
          target: "http://127.0.0.1:9999",
        }
      },
      watch: {
        usePolling: true,
        interval: 300,
      }
    }
  }
});

