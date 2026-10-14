#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "./src/install.js";

const binPath = join(dirname(fileURLToPath(import.meta.url)), "bin", "tiny-engineer-claude-hooks.js");
const code = await runInstall(process.argv.slice(2), { binPath });
// A timed-out health check can leave a socket open; do not wait for it.
process.exit(code);
