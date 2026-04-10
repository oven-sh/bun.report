#!/usr/bin/env bun
// Runs on the server as the `bun` user via Tailscale SSH from GitHub Actions.
import { $ } from "bun";
import path from "node:path";

const REPO_DIR = path.resolve(import.meta.dir, "..");
const DB_FILE = path.join(REPO_DIR, "bun-remap.db");
const bun = process.execPath;

process.chdir(REPO_DIR);

console.log("==> Fetching origin/main");
await $`git fetch origin main`;
const oldSha = (await $`git rev-parse HEAD`.text()).trim();
await $`git reset --hard origin/main`;
const newSha = (await $`git rev-parse HEAD`.text()).trim();
console.log(`    ${oldSha} -> ${newSha}`);

console.log("==> Installing dependencies");
await $`${bun} install --frozen-lockfile`;

console.log("==> Building");
await $`${bun} build.ts`;

const commitMsg = await $`git log -1 --pretty=%B`.text();
if (/\[wipe-db\]/i.test(commitMsg) || process.argv.includes("wipe-db")) {
  console.log(`==> Wiping ${DB_FILE}`);
  await $`rm -f ${DB_FILE}`;
}

console.log("==> Restarting bun.report.service");
await $`sudo /usr/bin/systemctl restart bun.report.service`;

console.log("==> Waiting for service to become active");
for (let i = 0; i < 30; i++) {
  const r = await $`systemctl is-active --quiet bun.report.service`.nothrow();
  if (r.exitCode === 0) {
    const pid = (await $`systemctl show -p MainPID --value bun.report.service`.text()).trim();
    console.log(`==> Deploy OK (${newSha}, pid ${pid})`);
    process.exit(0);
  }
  await Bun.sleep(1000);
}

// Actions logs on this public repo are world-readable; the service logs can
// contain Authorization headers (BUN_CONFIG_VERBOSE_FETCH), so never dump them.
console.error("!! bun.report.service did not become active within 30s");
console.error("   On the server: journalctl -u bun.report.service -n 100");
process.exit(1);
