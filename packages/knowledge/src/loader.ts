import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type KnowledgeDoc = {
  sourceId: string; // relative path under content/
  text: string;
};

function getPackageRootDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // .../packages/knowledge/src
  return path.resolve(here, "..");
}

async function listMarkdownFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listMarkdownFilesRecursive(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

export async function loadKnowledgeDocs(): Promise<KnowledgeDoc[]> {
  const root = getPackageRootDir();
  const contentDir = path.join(root, "content");
  const files = await listMarkdownFilesRecursive(contentDir);
  const docs = await Promise.all(
    files.map(async (absPath) => {
      const text = await readFile(absPath, "utf8");
      const rel = path.relative(contentDir, absPath).replaceAll("\\", "/");
      return { sourceId: rel, text };
    }),
  );
  return docs;
}

