'use strict';
// 用法: node verify.js <app.asar> [--dir <解包目录>] [--manifest <path>]
//                     [--unpacked-dir <目录>] [--no-bytes] [--require <模块>]...
//
// 通用 asar 校验，覆盖常见"重新打包后启动失败"问题：
//   1. header pickle 字段自洽、offset 连续、归档大小精确
//   2. 内联条目必须有 offset；unpacked 条目必须没有
//   3. unpacked 条目在 <asar>.unpacked 中存在且尺寸一致
//   4. <asar>.unpacked 中的文件必须在 header 中声明（反向检查：
//      丢失 unpacked 声明会导致 require('模块') 找不到，正是本次故障）
//   5. 与解包目录逐字节比对（条目集合、尺寸、内容）
//   6. 与 manifest 比对（条目集合、unpacked/executable 标志）
//   7. package.json 可解析、main 指向的条目存在
//   8. --require 指定的模块可解析（package.json + main 文件都在 header 中）
const path = require('path');
const { verifyAsar, printReport, ensureUtf8Console } = require('./lib');
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
const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] && args[i - 1].startsWith('--')));
const asarArg = pos[0];
if (!asarArg) {
  console.error('用法: node verify.js <app.asar> [--dir <解包目录>] [--manifest <path>] [--unpacked-dir <目录>] [--no-bytes] [--require <模块>]...');
  process.exit(2);
}

const result = verifyAsar({
  asarPath: path.resolve(asarArg),
  dir: flagValue('--dir') ? path.resolve(flagValue('--dir')) : null,
  manifestPath: flagValue('--manifest') ? path.resolve(flagValue('--manifest')) : null,
  unpackedDir: flagValue('--unpacked-dir') ? path.resolve(flagValue('--unpacked-dir')) : null,
  checkBytes: !args.includes('--no-bytes'),
  requireModules: flagValues('--require'),
});
printReport(result, 'asar 校验');
process.exit(result.ok ? 0 : 1);
