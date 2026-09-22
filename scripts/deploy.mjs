// scripts/deploy.mjs — 部署前把 git 短 hash 注入为 RELEASE_VERSION 版本号，
// 并把 index.html 中的 __APP_VERSION__ 占位符替换为该版本号（静态资源 URL 携带缓存指纹）
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function gitHash() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const version = gitHash();
console.log(`RELEASE_VERSION=${version}`);

// Workers Static Assets 由 Cloudflare 直接服务、不经 Worker 主入口，
// 因此必须在构建期把版本指纹写进 index.html 再上传。
const indexPath = join('public', 'index.html');
const orig = readFileSync(indexPath, 'utf8');
const injected = orig.replaceAll('__APP_VERSION__', version);
writeFileSync(indexPath, injected, 'utf8');

try {
  const args = ['wrangler', 'deploy', `--var=RELEASE_VERSION:${version}`];
  const res = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exitCode = res.status ?? 1;
} finally {
  // 无论成败都还原源文件，避免污染 git 工作树
  writeFileSync(indexPath, orig, 'utf8');
}