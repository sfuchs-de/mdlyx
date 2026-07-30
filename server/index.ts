import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServiceApp } from "./bootstrap.js";
import { createRequestRouter } from "./router.js";

const port = Number(process.env.PORT ?? 10000);
const app = await createServiceApp();
// Resolve from the compiled server module rather than process.cwd(): hosting
// platforms are free to launch the start command from another directory.
const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const server = createServer(createRequestRouter(app, staticRoot));

server.listen(port, "0.0.0.0", () => {
  console.info(`research-library-api listening on ${port}`);
});
