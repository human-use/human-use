import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Notebook } from "./runtime.js";

/**
 * The driver's notebook as markdown files. Append-only between weekly tidy-ups: every line carries the job that
 * prompted it, so two calls writing at once cannot overwrite each other and a bad line can be traced.
 */
export class FileNotebook implements Notebook {
  constructor(private readonly dir: string, private readonly cap = 6000) {
    mkdirSync(dir, { recursive: true });
  }

  pages(): string[] {
    return readdirSync(this.dir, { withFileTypes: true }).filter(entry => entry.isFile() && /^[a-z0-9_-]{1,40}\.md$/.test(entry.name))
      .map(entry => entry.name.slice(0, -3)).sort();
  }

  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.pages().map(page => [page, readFileSync(join(this.dir, `${page}.md`), "utf8")]));
  }

  read(requested?: readonly string[]): string {
    const pages = this.pages().filter(page => !requested || requested.includes(page));
    const limit = Math.floor(this.cap / Math.max(1, pages.length));
    return pages.map(page => `# ${page}\n${readFileSync(join(this.dir, `${page}.md`), "utf8").trim().slice(-Math.max(1, limit))}`).join("\n\n");
  }

  append(page: string, text: string, ref: string, at: string): void {
    appendFileSync(join(this.dir, `${page}.md`), `- [${at.slice(0, 16)} ${ref}] ${text.replace(/\s+/g, " ").trim()}\n`);
  }

  rewrite(page: string, previous: string, text: string): boolean {
    const path = join(this.dir, `${page}.md`);
    if (readFileSync(path, "utf8") !== previous) return false;
    const temp = join(this.dir, `.notebook-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, text.length && !text.endsWith("\n") ? `${text}\n` : text, { flag: "wx" });
      renameSync(temp, path);
      return true;
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
