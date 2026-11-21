'use strict';
// 用法: node pack.js <解包目录> <输出.asar> [--manifest <path>] [--from-asar <原版asar>] [--unpacked-dir <目录>]
//
// 按 manifest 还原 header（结构 / 顺序 / unpacked 标志），从目录读取数据打包，
// 打包完成后立即执行完整校验（条目集合、尺寸、offset 连续、逐字节比对、
// unpacked 文件位于 <输出>.unpacked、package.json 可解析）。
//
// 注意：manifest 中标记 unpacked 的文件
// 不会写入 asar，运行时由 <输出>.asar.unpacked 提供。
const fs = require('fs');
const path = require('path');
const { readAsarHeader, flatten, dataOrderOf, walkDisk, copyRange, buildHeaderBlock, verifyAsar, printReport, ensureUtf8Console } = require('./lib');
ensureUtf8Console();

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
function flagValues(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
}
const pos = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [dirArg, outArg] = pos;
if (!dirArg || !outArg) {
  console.error('用法: node pack.js <解包目录> <输出.asar> [--manifest <path>] [--from-asar <原版asar>] [--unpacked-dir <目录>] [--require <模块>]...');
  process.exit(2);
}

const dir = path.resolve(dirArg);
const outAsar = path.resolve(outArg);
const manifestPath = flagValue('--manifest') ? path.resolve(flagValue('--manifest')) : dir + '.manifest.json';
const fromAsar = flagValue('--from-asar') ? path.resolve(flagValue('--from-asar')) : null;
const unpackedDir = flagValue('--unpacked-dir') ? path.resolve(flagValue('--unpacked-dir')) : null;

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error('目录不存在: ' + dir); process.exit(2); }

// ---- 载入 manifest（缺失时可从 --from-asar 生成）----
let manifest;
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('manifest: ' + manifestPath);
} else if (fromAsar) {
  const h = readAsarHeader(fromAsar);
  manifest = {
    version: 1,
    source: path.resolve(fromAsar),
    createdAt: new Date().toISOString(),
    header: h.json,
    dataOrder: dataOrderOf(h.entries).map(e => e.path),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`manifest 不存在，已从 ${fromAsar} 生成 -> ${manifestPath}`);
} else {
  console.error(`缺少 manifest: ${manifestPath}\n先执行 unpack.js，或加 --from-asar <原版asar> 生成。`);
  process.exit(2);
}

// ---- 目录与 manifest 条目集合必须一致（link 条目不落盘，单独保留）----
const disk = walkDisk(dir);
const diskMap = new Map(disk.map(f => [f.rel, f]));
const mEntries = flatten(manifest.header);
const mPaths = new Set(mEntries.filter(e => !e.entry.link).map(e => e.path));
const linkPaths = mEntries.filter(e => e.entry.link).map(e => e.path);
const missing = [...mPaths].filter(p => !diskMap.has(p));
const extra = [...diskMap.keys()].filter(p => !mPaths.has(p));
if (missing.length || extra.length) {
  console.error('目录与 manifest 条目不一致:');
  missing.slice(0, 20).forEach(p => console.error('  缺少: ' + p));
  if (missing.length > 20) console.error(`  ... 另有 ${missing.length - 20} 个`);
  extra.slice(0, 20).forEach(p => console.error('  多余: ' + p));
  if (extra.length > 20) console.error(`  ... 另有 ${extra.length - 20} 个`);
  console.error('（提示：本工具解包的目录才是完整的；其它解包工具可能会漏掉 unpacked 条目）');
  process.exit(1);
}

// ---- 克隆 header，按磁盘尺寸 + 数据顺序重算 offset ----
const header = JSON.parse(JSON.stringify(manifest.header));
const cEntries = flatten(header);
const dataOrderPaths = Array.isArray(manifest.dataOrder) && manifest.dataOrder.length
  ? manifest.dataOrder
  : dataOrderOf(mEntries).map(e => e.path);

const packedSet = new Set(mEntries.filter(e => !e.entry.unpacked && !e.entry.link).map(e => e.path));
const orderSeen = new Set();
for (const p of dataOrderPaths) {
  if (!packedSet.has(p)) { console.error('dataOrder 含非内联条目: ' + p); process.exit(1); }
  if (orderSeen.has(p)) { console.error('dataOrder 重复条目: ' + p); process.exit(1); }
  orderSeen.add(p);
}
for (const p of packedSet) {
  if (!orderSeen.has(p)) { console.error('dataOrder 未覆盖内联条目: ' + p); process.exit(1); }
}

const cMap = new Map(cEntries.map(e => [e.path, e]));
for (const e of cEntries) {
  if (e.entry.link) continue; // link 条目原样保留（不落盘、无 size/offset）
  e.entry.size = diskMap.get(e.path).size; // 尺寸以磁盘为准（补丁会改变文件大小）
}

let cursor = 0;
for (const p of dataOrderPaths) {
  const entry = cMap.get(p).entry;
  entry.offset = String(cursor);
  cursor += entry.size;
}
const dataBytes = cursor;
const headerBlock = buildHeaderBlock(header);
const cUnpacked = cEntries.filter(e => e.entry.unpacked).length;
console.log(`内联 ${dataOrderPaths.length} 个文件 / unpacked ${cUnpacked} 个 / link ${linkPaths.length} 个`);
console.log(`header ${headerBlock.length} 字节 + 数据 ${dataBytes} 字节 = ${headerBlock.length + dataBytes} 字节`);

// ---- 写出 ----
const fd = fs.openSync(outAsar, 'w');
try {
  fs.writeSync(fd, headerBlock, 0, headerBlock.length, 0);
  let pos = headerBlock.length;
  for (const p of dataOrderPaths) {
    const f = diskMap.get(p);
    const sfd = fs.openSync(f.abs, 'r');
    try { copyRange(sfd, 0, fd, pos, f.size); } finally { fs.closeSync(sfd); }
    pos += f.size;
  }
  if (pos !== headerBlock.length + dataBytes) throw new Error('写入大小不符');
} finally {
  fs.closeSync(fd);
}
console.log('已写出: ' + outAsar);

// ---- 打包后校验 ----
const result = verifyAsar({ asarPath: outAsar, dir, manifestPath, unpackedDir, requireModules: flagValues('--require') });
printReport(result, '打包校验');
process.exit(result.ok ? 0 : 1);
