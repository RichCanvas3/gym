import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "e2e", ".libs", "root");
const debs = path.join(process.cwd(), "e2e", ".libs", "debs");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(debs, { recursive: true });

// Minimal set discovered in this environment for Playwright Chromium.
const packages = ["libnspr4", "libnss3", "libasound2t64"];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

for (const pkg of packages) {
  // Skip if already extracted (best-effort).
  if (pkg === "libnspr4") {
    const so = path.join(root, "usr", "lib", "x86_64-linux-gnu", "libnspr4.so");
    if (fs.existsSync(so)) continue;
  }
  if (pkg === "libnss3") {
    const so = path.join(root, "usr", "lib", "x86_64-linux-gnu", "libnss3.so");
    if (fs.existsSync(so)) continue;
  }
  if (pkg === "libasound2t64") {
    const so = path.join(root, "usr", "lib", "x86_64-linux-gnu", "libasound.so.2");
    if (fs.existsSync(so)) continue;
  }

  run("apt-get", ["download", pkg], debs);
  const files = fs
    .readdirSync(debs)
    .filter((f) => f.endsWith(".deb") && f.includes(pkg))
    .map((f) => path.join(debs, f));
  for (const f of files) run("dpkg-deb", ["-x", f, root], debs);
}

