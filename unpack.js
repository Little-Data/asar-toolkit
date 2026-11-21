'use strict';
// 用法: node unpack.js <app.asar> <输出目录> [--force] [--unpacked-dir <目录>]
// 解包 asar（含 unpacked 条目：从 <asar>.unpacked 复制，保证输出目录完整），
// 并生成 <输出目录>.manifest.json（header 结构 + 标志 + 数据顺序），供 pack 使用。
const fs = require('fs');
const path = require('path');
const { readAsarHeader, dataOrderOf, headerDirs, copyRange, verifyAsar, printReport, ensureUtf8Console } = require('./lib');
ensureUtf8Console();

const args = process.argv.slice(2);
const force = args.includes('--force');
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] && args[i - 1].startsWith('--')));
const [asarArg, outArg] = pos;
if (!asarArg || !outArg) {
  console.error('用法: node unpack.js <app.asar> <输出目录> [--force] [--unpacked-dir <目录>]');
  process.exit(2);
}

const asarPath = path.resolve(asarArg);
const outDir = path.resolve(outArg);
const manifestPath = outDir + '.manifest.json';
const unpackedDir = flagValue('--unpacked-dir') ? path.resolve(flagValue('--unpacked-dir')) : asarPath + '.unpacked';

if (!fs.existsSync(asarPath)) { console.error('asar 不存在: ' + asarPath); process.exit(2); }
if (fs.existsSync(outDir)) {
  const files = fs.readdirSync(outDir);
  if (files.length && !force) {
    console.error(`输出目录非空: ${outDir}（加 --force 覆盖）`);
    process.exit(2);
  }
  if (force) fs.rmSync(outDir, { recursive: true, force: true });
}

const h = readAsarHeader(asarPath);
const hasUnpacked = h.entries.some(e => e.entry.unpacked);
if (hasUnpacked && !fs.existsSync(unpackedDir)) {
  console.error(`找不到 unpacked 数据目录: ${unpackedDir}`);
  console.error('（该 asar 有 unpacked 条目，数据不在 asar 内；请用 --unpacked-dir 指定，通常是应用目录下的 <名字>.asar.unpacked）');
  process.exit(1);
}
const errors = [];
let copied = 0, extracted = 0;

console.log(`asar: ${asarPath}`);
console.log(`条目: ${h.entries.length}（内联 ${dataOrderOf(h.entries).length} / unpacked ${h.entries.filter(e => e.entry.unpacked).length}）`);

fs.mkdirSync(outDir, { recursive: true });
for (const d of headerDirs(h.json)) fs.mkdirSync(path.join(outDir, ...d.split('/')), { recursive: true }); // 含空目录
const asarFd = fs.openSync(asarPath, 'r');
try {
  for (const { path: p, entry } of h.entries) {
    const target = path.join(outDir, ...p.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.link) { errors.push('不支持 link 条目: ' + p); continue; }
    if (entry.unpacked) {
      // unpacked 条目：数据不在 asar 内，从 <asar>.unpacked 取
      const src = path.join(unpackedDir, ...p.split('/'));
      if (!fs.existsSync(src)) { errors.push('app.asar.unpacked 中缺失: ' + p); continue; }
      const st = fs.statSync(src);
      if (st.size !== entry.size) { errors.push(`尺寸不符(unpacked): ${p} (${st.size} != ${entry.size})`); continue; }
      const sfd = fs.openSync(src, 'r');
      try {
        const dfd = fs.openSync(target, 'w');
        try { copyRange(sfd, 0, dfd, 0, st.size); } finally { fs.closeSync(dfd); }
      } finally { fs.closeSync(sfd); }
      copied++;
    } else {
      const dfd = fs.openSync(target, 'w');
      try { copyRange(asarFd, h.dataOffset + Number(entry.offset), dfd, 0, entry.size); }
      finally { fs.closeSync(dfd); }
      extracted++;
    }
  }
} finally {
  fs.closeSync(asarFd);
}

if (errors.length) {
  console.error('\n解包失败:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

const manifest = {
  version: 1,
  source: asarPath,
  createdAt: new Date().toISOString(),
  header: h.json,
  dataOrder: dataOrderOf(h.entries).map(e => e.path),
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`\n已解包 ${extracted} 个内联文件 + ${copied} 个 unpacked 文件 -> ${outDir}`);
console.log('manifest: ' + manifestPath);

const result = verifyAsar({ asarPath, dir: outDir, manifestPath, unpackedDir });
printReport(result, '解包校验');
process.exit(result.ok ? 0 : 1);
