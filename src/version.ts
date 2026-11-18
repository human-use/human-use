import { createRequire } from "node:module";

/** Read from package.json so the CLI, MCP server and daemon never disagree. Works from src/ (tsx) and dist/. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
