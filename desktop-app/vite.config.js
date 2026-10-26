import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

export default {
  test: {
    // Node packaging tests run separately under node --test in Desktop CI.
    include: ["src/renderer/**/*.test.{js,jsx}"],
    // Run the linked workspace packages (and their dependencies) through Vite
    // so `resolve.dedupe` binds them to this renderer's single React copy.
    server: { deps: { inline: [/packages\/(ui|chat)\//] } },
    alias: [
      { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-runtime.js", import.meta.url)) },
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-dev-runtime.js", import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/index.js", import.meta.url)) },
      { find: /^lucide-react$/, replacement: fileURLToPath(new URL("./node_modules/lucide-react/dist/esm/lucide-react.mjs", import.meta.url)) }
    ]
  },
  // Shared packages (@hatch/chat) use the automatic JSX runtime.
  esbuild: { jsx: "automatic" },
  resolve: {
    // @hatch/ui is consumed from its workspace source. Always bind React to
    // the desktop renderer's copy so linked-package dependencies cannot create
    // a second hook dispatcher in production bundles.
    dedupe: ["react", "react-dom"]
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Shared UI source resolves its font assets from packages/ui/node_modules.
    // Keep localhost visually identical to the packaged app instead of
    // silently falling back to a wider system serif.
    fs: {
      allow: [workspaceRoot]
    }
  },
  clearScreen: false
};
