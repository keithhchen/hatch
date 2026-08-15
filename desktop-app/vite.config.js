import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

export default {
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
