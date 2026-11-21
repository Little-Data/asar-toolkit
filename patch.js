'use strict';
// 通用补丁工具：把"对某个解包文件的文本替换"定义成 patches/*.json，可重复应用 / 回退。
//
// 用法:
//   node patch.js <解包目录> [--list] [--id <补丁id>] [--revert] [--check] [--patch-dir <目录>]
//   --list    只列出补丁定义及在目标上的状态
//   --check   只检查状态，不修改文件
//   --revert  回退（应用 new -> old）
//   --id      只处理指定补丁（找不到模式时视为失败）
//
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sha256, ensureUtf8Console } = require('./lib');
ensureUtf8Console();

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const revert = args.includes('--revert');
const checkOnly = args.includes('--check');
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const idFilter = flagValue('--id');
const patchDir = flagValue('--patch-dir') ? path.resolve(flagValue('--patch-dir')) : path.join(__dirname, 'patches');
const pos = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] && args[i - 1].startsWith('--')));
if (!pos[0]) {
  console.error('用法: node patch.js <解包目录> [--list] [--id <补丁id>] [--revert] [--check] [--patch-dir <目录>]');
  process.exit(2);
}

const input = path.resolve(pos[0]);
const inputIsDir = fs.existsSync(input) && fs.statSync(input).isDirectory();

// 载入补丁定义
if (!fs.existsSync(patchDir)) { console.error('补丁目录不存在: ' + patchDir); process.exit(2); }
let patches = fs.readdirSync(patchDir).filter(f => f.endsWith('.json')).map(f => {
  const def = JSON.parse(fs.readFileSync(path.join(patchDir, f), 'utf8'));
  for (const k of ['id', 'target', 'old', 'new']) {
    if (typeof def[k] !== 'string' || !def[k]) throw new Error(`${f}: 缺少字段 ${k}`);
  }
  if (def.old === def.new) throw new Error(`${f}: old 与 new 相同`);
  return def;
});
if (idFilter) patches = patches.filter(p => p.id === idFilter);
if (!patches.length) { console.error(idFilter ? `未找到补丁: ${idFilter}` : '补丁目录中没有 *.json 定义'); process.exit(2); }

const results = [];
let applied = 0, already = 0, unknown = 0, failed = 0;

for (const p of patches) {
  const file = inputIsDir ? path.join(input, ...p.target.split('/')) : input;
  const line = { id: p.id, file, state: '', action: '' };

  if (!fs.existsSync(file)) {
    line.state = 'missing';
    line.action = idFilter ? '失败：目标文件不存在' : '跳过：目标文件不存在';
    if (idFilter) failed++;
    results.push(line);
    continue;
  }

  const before = fs.readFileSync(file);
  const text = before.toString('utf8');
  if (p.contains && !text.includes(p.contains)) {
    line.state = 'wrong-file';
    line.action = `跳过：文件缺少特征串 ${JSON.stringify(p.contains)}`;
    if (idFilter) failed++;
    results.push(line);
    continue;
  }

  const hasOld = text.includes(p.old);
  const hasNew = text.includes(p.new);
  const desiredState = revert ? 'original' : 'patched';
  const state = hasNew ? 'patched' : hasOld ? 'original' : 'unknown';
  line.state = state + ` (${before.length} 字节, sha256 ${sha256(before).slice(0, 12)}…)`;

  if (state === 'unknown') {
    line.action = '未匹配到 old/new 任一模式（应用版本可能已更新，需重新提取模式）';
    unknown++;
    if (idFilter) failed++;
    results.push(line);
    continue;
  }

  if (state === desiredState) {
    line.action = revert ? '已是原版，无需回退' : '补丁已应用，无需重复';
    already++;
    results.push(line);
    continue;
  }

  if (listOnly || checkOnly) {
    line.action = revert ? '将回退 (new -> old)' : '将应用 (old -> new)';
    results.push(line);
    continue;
  }

  const after = Buffer.from(state === 'patched' ? text.replace(p.new, p.old) : text.replace(p.old, p.new), 'utf8');
  fs.writeFileSync(file, after);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    line.action = `${revert ? '已回退' : '已应用'}，语法检查通过 (${after.length} 字节, sha256 ${sha256(after).slice(0, 12)}…)`;
    applied++;
  } catch (err) {
    fs.writeFileSync(file, before); // 语法检查失败则还原
    line.action = '语法检查失败，已还原原文件: ' + String(err.stderr || err.message).split('\n')[0];
    failed++;
  }
  results.push(line);
}

console.log(listOnly ? '\n== 补丁清单 ==' : '\n== 补丁处理 ==');
for (const r of results) {
  console.log(`  [${r.id}]`);
  console.log(`      文件: ${r.file}`);
  console.log(`      状态: ${r.state || '-'}`);
  console.log(`      动作: ${r.action}`);
}
console.log(`\n合计: 应用 ${applied} / 已是目标状态 ${already} / 未匹配 ${unknown} / 失败 ${failed}`);

if (listOnly || checkOnly) process.exit(unknown && idFilter ? 1 : 0);
if (failed) process.exit(1);
if (!applied && !already) {
  console.error('没有任何补丁与该文件匹配。');
  process.exit(1);
}
process.exit(0);
