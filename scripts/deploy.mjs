// scripts/deploy.mjs — 部署前用 git 短 hash 注入 RELEASE_VERSION 为发布版本号
import { execSync, spawnSync } from 'node:child_process';

function gitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const version = gitHash();
console.log(`RELEASE_VERSION=${version}`);
const args = ['wrangler', 'deploy', `--var=RELEASE_VERSION:${version}`];
const res = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(res.status ?? 1);