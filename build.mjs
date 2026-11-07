// 构建脚本：把 src/ 下的模块按顺序拼进 shell.html 的 /*__MODULES__*/ 标记处
// 产物是一个完全自包含的单文件 HTML，双击即可玩。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, 'src', f), 'utf8');

// 顺序很重要：后面的模块依赖前面的全局对象
const MODULES = [
  '01-core.js',
  '02-race.js',
  '03-hud.js',
  '04-gl3d.js',
  '05-audio.js',
  '06-game.js',
];

const shell = src('shell.html');
const marker = '/*__MODULES__*/';
if (!shell.includes(marker)) {
  console.error('shell.html 缺少 /*__MODULES__*/ 标记');
  process.exit(1);
}

const bundle = MODULES.map((f) => `/* ==================== ${f} ==================== */\n` + src(f)).join('\n\n');
const out = shell.replace(marker, bundle);

writeFileSync(join(here, 'verstappen-racing.html'), out, 'utf8');

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
const lines = out.split('\n').length;
console.log(`[build] verstappen-racing.html  ${kb} KB  ${lines} 行  (${MODULES.length} 个模块)`);
