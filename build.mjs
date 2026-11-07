// 构建脚本：把 src/ 下的模块按顺序拼进 shell.html 的 /*__MODULES__*/ 标记处
// 产物：
//   verstappen-racing.html             ← 最新构建（总是这个文件名，方便覆盖试玩）
//   dist/verstappen-racing-V<版本>.html ← 本版本快照（每次构建自动新建一个）
//   version.txt                         ← 构建成功后自动 +1（V1.0 → V1.1）
//
// 用法：node build.mjs          （构建当前版本，不递增 —— 调 bug 时反复构建用这个）
//       node build.mjs --bump   （先 +0.1 再构建 —— 一次真实改动 = 一个版本）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, 'src', f), 'utf8');
const doBump = process.argv.includes('--bump');

// 版本号：version.txt 里存 "1.0"
const VERSION_FILE = join(here, 'version.txt');
if (!existsSync(VERSION_FILE)) writeFileSync(VERSION_FILE, '1.0\n', 'utf8');
const version = readFileSync(VERSION_FILE, 'utf8').trim() || '1.0';
const tag = 'V' + version;

// 顺序很重要：后面的模块依赖前面的全局对象
const MODULES = [
  '01-core.js',
  '02-race.js',
  '03-hud.js',
  '04-gl3d.js',
  '05-audio.js',
  '06-game.js',
];

const shell = src('shell.html').replace(/\{\{VERSION\}\}/g, tag);
const marker = '/*__MODULES__*/';
if (!shell.includes(marker)) {
  console.error('shell.html 缺少 /*__MODULES__*/ 标记');
  process.exit(1);
}

const bundle = MODULES.map((f) => `/* ==================== ${f} ==================== */\n` + src(f)).join('\n\n');
const out = shell.replace(marker, bundle);

// 1) 最新构建
writeFileSync(join(here, 'verstappen-racing.html'), out, 'utf8');

// 2) 版本快照（dist/）
const distDir = join(here, 'dist');
if (!existsSync(distDir)) mkdirSync(distDir);
const snapshot = join(distDir, `verstappen-racing-${tag}.html`);
writeFileSync(snapshot, out, 'utf8');

// 3) 自动递增（V1.0 → V1.1，V1.9 → V2.0）
if (doBump) {
  const parts = version.split('.').map((n) => parseInt(n, 10) || 0);
  let minor = parts[1] || 0, major = parts[0] || 1;
  minor += 1;
  if (minor >= 10) { major += 1; minor = 0; }
  writeFileSync(VERSION_FILE, `${major}.${minor}\n`, 'utf8');
}

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
const lines = out.split('\n').length;
console.log(`[build] ${tag}  verstappen-racing.html  ${kb} KB  ${lines} 行  (${MODULES.length} 个模块)`);
console.log(`[build] 版本快照 → dist/verstappen-racing-${tag}.html`);
console.log(`[build] 当前版本 V${version}${doBump ? '（已递增到 V' + readFileSync(VERSION_FILE, 'utf8').trim() + '）' : '（未递增，改动后跑 node build.mjs --bump）'}`);
