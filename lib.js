'use strict';
// asar-toolkit 共享库：header 解析 / 目录遍历 / 分块拷贝 / 组装 header / 校验
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 解析 asar 头（pickle + JSON），返回结构化信息。 */
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error(`${file}: 文件过短，不是 asar`);
    if (head.readUInt32LE(0) !== 4) throw new Error(`${file}: pickle magic 不匹配，不是 asar`);
    const headerSize = head.readUInt32LE(4);
    const dataOffset = 8 + headerSize;
    const probe = Buffer.alloc(headerSize + 64);
    fs.readSync(fd, probe, 0, probe.length, 0);
    const start = probe.indexOf('{');
    if (start < 0) throw new Error(`${file}: 找不到 header JSON`);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < probe.length; i++) {
      const ch = probe[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === 0x5c) esc = true;
        else if (ch === 0x22) inStr = false;
        continue;
      }
      if (ch === 0x22) inStr = true;
      else if (ch === 0x7b) depth++;
      else if (ch === 0x7d) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error(`${file}: header JSON 未闭合`);
    const json = JSON.parse(probe.slice(start, end + 1).toString('utf8'));
    return { json, entries: flatten(json), dataOffset, headerSize, head };
  } finally {
    fs.closeSync(fd);
  }
}

/** 深度优先展开 header，返回 [{path, entry}]（仅文件条目）。 */
function flatten(json) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (entry.files) walk(entry, p);
      else out.push({ path: p, entry });
    }
  })(json, '');
  return out;
}

/** 展开 header 中的目录路径（含空目录），返回 ['a', 'a/b', ...]。 */
function headerDirs(json) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (entry.files) { out.push(p); walk(entry, p); }
    }
  })(json, '');
  return out;
}

/** 按原 offset 升序得到数据区写入顺序（仅内联文件；排除 unpacked 与 link）。 */
function dataOrderOf(entries) {
  return entries
    .filter(e => !e.entry.unpacked && !e.entry.link)
    .sort((a, b) => Number(a.entry.offset) - Number(b.entry.offset));
}

/** 遍历磁盘目录，返回按路径排序的 [{rel, abs, size}]，rel 使用 '/' 分隔。 */
function walkDisk(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const r = rel ? rel + '/' + name : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else out.push({ rel: r, abs, size: st.size });
    }
  })(dir, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 从 srcFd 的 srcPos 处拷贝 len 字节到 dstFd 的 dstPos。 */
function copyRange(srcFd, srcPos, dstFd, dstPos, len) {
  const buf = Buffer.alloc(Math.min(8 * 1024 * 1024, Math.max(len, 1)));
  let done = 0;
  while (done < len) {
    const n = fs.readSync(srcFd, buf, 0, Math.min(buf.length, len - done), srcPos + done);
    if (n <= 0) throw new Error('源文件读取不足');
    fs.writeSync(dstFd, buf, 0, n, dstPos + done);
    done += n;
  }
}

/** 读取文件某区段为 Buffer。 */
function readSlice(file, pos, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const n = fs.readSync(fd, buf, done, len - done, pos + done);
      if (n <= 0) throw new Error('读取不足');
      done += n;
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** 比较 asar 内 [pos, pos+len) 与磁盘文件内容是否一致。 */
function sliceEqualsFile(asarFd, pos, file, len) {
  const dfd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(dfd).size;
    if (size !== len) return false;
    const N = 4 * 1024 * 1024;
    const a = Buffer.alloc(Math.min(N, Math.max(len, 1)));
    const b = Buffer.alloc(Math.min(N, Math.max(len, 1)));
    let done = 0;
    while (done < len) {
      const m = Math.min(a.length, len - done);
      const na = fs.readSync(asarFd, a, 0, m, pos + done);
      const nb = fs.readSync(dfd, b, 0, m, done);
      if (na !== nb || !a.equals(b)) return false;
      done += m;
    }
    return true;
  } finally {
    fs.closeSync(dfd);
  }
}

/** 由 header JSON 组装 asar 头块（pickle + JSON）。返回 Buffer，dataOffset = block.length。 */
function buildHeaderBlock(json) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - ((4 + jsonBuf.length) % 4)) % 4;
  const payload = Buffer.alloc(4 + jsonBuf.length + pad);
  payload.writeInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(payload, 4);
  const pickle = Buffer.alloc(4 + payload.length);
  pickle.writeInt32LE(payload.length, 0);
  payload.copy(pickle, 4);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([head, pickle]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

/** Windows 交互式控制台切到 UTF-8，避免中文输出乱码（非 TTY 时不动父进程控制台）。 */
function ensureUtf8Console() {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return;
  try {
    require('child_process').execSync('chcp 65001 >nul', { stdio: 'ignore', shell: true });
  } catch { /* 忽略：控制台不可用时保持原样 */ }
}

/**
 * 校验 asar：
 *  - 头部 pickle 字段自洽
 *  - 与 manifest 的条目集合 / unpacked 标志一致（可选）
 *  - 与磁盘目录的条目集合、尺寸一致，并逐字节比对（可选）
 *  - offset 连续、归档大小精确
 *  - unpacked 条目在 <asar>.unpacked 中存在且尺寸一致
 *  - package.json 可解析且含 main
 */
function verifyAsar({ asarPath, dir = null, manifestPath = null, unpackedDir = null, checkBytes = true, requireModules = [] }) {
  const problems = [];
  const stats = {};
  const h = readAsarHeader(asarPath);
  const st = fs.statSync(asarPath);

  if (h.head.readUInt32LE(4) !== h.headerSize) problems.push('头部字段 u32@4 != headerSize');

  const links = h.entries.filter(e => e.entry.link);
  const packed = dataOrderOf(h.entries);
  const unpacked = h.entries.filter(e => e.entry.unpacked);
  stats.total = h.entries.length;
  stats.packed = packed.length;
  stats.unpacked = unpacked.length;
  if (links.length) stats.linkEntries = links.map(e => e.path);

  // 内联条目必须有 offset；unpacked 条目必须没有 offset
  const noOffset = h.entries.filter(e => !e.entry.unpacked && !e.entry.link && e.entry.offset === undefined);
  if (noOffset.length) {
    problems.push(`内联条目缺少 offset（${noOffset.length} 个），例如: ${noOffset.slice(0, 5).map(e => e.path).join(', ')}`);
  }
  const packedWithOffset = unpacked.filter(e => e.entry.offset !== undefined);
  if (packedWithOffset.length) {
    problems.push(`unpacked 条目带 offset（${packedWithOffset.length} 个），例如: ${packedWithOffset.slice(0, 5).map(e => e.path).join(', ')}`);
  }

  // offset 连续性 + 归档大小
  let cursor = 0, bad = 0;
  const badList = [];
  for (const e of packed) {
    if (Number(e.entry.offset) !== cursor) { bad++; if (badList.length < 5) badList.push(e.path); }
    cursor += e.entry.size;
  }
  if (bad) problems.push(`offset 不连续（${bad} 处），例如: ${badList.join(', ')}`);
  const expectedSize = h.dataOffset + cursor;
  stats.dataBytes = cursor;
  if (expectedSize !== st.size) problems.push(`归档大小不符: 期望 ${expectedSize}，实际 ${st.size}`);
  stats.archiveSize = st.size;

  // unpacked 条目对应的文件必须真实存在于 <asar>.unpacked
  const upDir = unpackedDir || asarPath + '.unpacked';
  stats.unpackedDir = upDir;
  const upDirExists = fs.existsSync(upDir);
  if (unpacked.length && !upDirExists) {
    problems.push(`unpacked 目录不存在: ${upDir}（可用 --unpacked-dir 指定，通常在应用安装目录下）`);
  }
  for (const e of unpacked) {
    if (!upDirExists) break;
    const p = path.join(upDir, ...e.path.split('/'));
    if (!fs.existsSync(p)) problems.push(`unpacked 文件缺失: ${p}`);
    else if (fs.statSync(p).size !== e.entry.size) problems.push(`unpacked 尺寸不符: ${e.path} (${fs.statSync(p).size} != ${e.entry.size})`);
  }

  // 反向检查：<asar>.unpacked 里存在、但 header 未声明的文件。
  // 这正是"重新打包时丢失 unpacked 条目"的症状：文件在磁盘上，运行时 require 却找不到。
  if (upDirExists) {
    const declared = new Set(unpacked.map(e => e.path));
    const orphans = walkDisk(upDir).filter(f => !declared.has(f.rel)).map(f => f.rel);
    stats.unpackedOrphans = orphans.length;
    if (orphans.length) {
      problems.push(
        `${upDir} 中有 ${orphans.length} 个文件未在 asar header 中声明为 unpacked（require 将找不到它们），例如: ` +
        orphans.slice(0, 5).join(', ')
      );
    }
  }

  // 与 manifest 对比（条目集合 + 标志）
  if (manifestPath) {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mEntries = flatten(m.header);
    const mMap = new Map(mEntries.map(e => [e.path, e.entry]));
    const aMap = new Map(h.entries.map(e => [e.path, e.entry]));
    for (const [p, me] of mMap) {
      if (!aMap.has(p)) problems.push(`manifest 有但 asar 缺少: ${p}`);
      else {
        const ae = aMap.get(p);
        if (!!ae.unpacked !== !!me.unpacked) problems.push(`unpacked 标志不一致: ${p}`);
        if (!!ae.executable !== !!me.executable) problems.push(`executable 标志不一致: ${p}`);
      }
    }
    for (const p of aMap.keys()) if (!mMap.has(p)) problems.push(`asar 有但 manifest 缺少: ${p}`);
    stats.manifestEntries = mEntries.length;
  }

  // 与磁盘目录对比（集合 + 尺寸 + 逐字节）
  if (dir) {
    const disk = walkDisk(dir);
    const dMap = new Map(disk.map(f => [f.rel, f]));
    const fileEntries = h.entries.filter(e => !e.entry.link); // link 条目不落盘
    const aMap = new Map(fileEntries.map(e => [e.path, e.entry]));
    for (const f of disk) if (!aMap.has(f.rel)) problems.push(`磁盘有但 asar 缺少: ${f.rel}`);
    for (const e of fileEntries) if (!dMap.has(e.path)) problems.push(`asar 有但磁盘缺少: ${e.path}`);
    for (const e of fileEntries) {
      const f = dMap.get(e.path);
      if (f && f.size !== e.entry.size) problems.push(`尺寸不一致: ${e.path} (磁盘 ${f.size} vs asar ${e.entry.size})`);
    }
    stats.diskFiles = disk.length;

    if (checkBytes && !problems.length) {
      const fd = fs.openSync(asarPath, 'r');
      try {
        let mismatch = 0;
        for (const e of packed) {
          const f = dMap.get(e.path);
          if (!f) continue;
          if (!sliceEqualsFile(fd, h.dataOffset + Number(e.entry.offset), f.abs, e.entry.size)) {
            mismatch++;
            if (mismatch <= 5) problems.push(`内容不一致: ${e.path}`);
          }
        }
        if (mismatch > 5) problems.push(`内容不一致: 另有 ${mismatch - 5} 个文件`);
        stats.byteCompared = packed.length;
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  // package.json 可解析，且 main 指向的条目必须存在（否则应用启动即崩）
  const entryOf = p => h.entries.find(e => e.path === p);
  const readEntry = e => {
    if (e.entry.unpacked) {
      const p = path.join(upDir, ...e.path.split('/'));
      if (!fs.existsSync(p)) throw new Error('unpacked 文件缺失: ' + p);
      return fs.readFileSync(p);
    }
    return readSlice(asarPath, h.dataOffset + Number(e.entry.offset), e.entry.size);
  };
  // Node 解析规则：main 无扩展名时依次尝试 原值 / .js / .json / /index.js
  const resolveMain = (base, dirPrefix = '') => {
    const b = String(base).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    const full = (dirPrefix ? dirPrefix.replace(/\/+$/, '') + '/' : '') + b;
    const cands = [full];
    if (!/\.[a-z0-9]+$/i.test(b)) cands.push(full + '.js', full + '.json', full + '/index.js');
    for (const c of cands) {
      const e = entryOf(c);
      if (e && !e.entry.link) return c;
    }
    return null;
  };
  const pkgEntry = entryOf('package.json');
  let pkg = null;
  if (!pkgEntry) problems.push('缺少 package.json');
  else {
    try {
      pkg = JSON.parse(readEntry(pkgEntry).toString('utf8'));
      stats.packageMain = pkg.main;
      if (!pkg.main) problems.push('package.json 缺少 main');
      else {
        const resolved = resolveMain(pkg.main);
        if (!resolved) problems.push(`package.json main 指向的条目不存在: ${pkg.main}`);
        else stats.packageMainResolved = resolved;
      }
    } catch (err) {
      problems.push('package.json 解析失败: ' + err.message);
    }
  }

  // 指定依赖模块必须可解析（node_modules/<name>/package.json + 其 main 文件）
  for (const name of requireModules) {
    const key = 'module:' + name;
    const mp = `node_modules/${name}/package.json`;
    const me = entryOf(mp);
    if (!me) { problems.push(`require('${name}') 会失败: 缺少 ${mp}`); stats[key] = 'MISSING'; continue; }
    try {
      const m = JSON.parse(readEntry(me).toString('utf8'));
      const resolved = resolveMain(m.main || 'index.js', `node_modules/${name}`);
      if (!resolved) { problems.push(`require('${name}') 会失败: main(${m.main || 'index.js'}) 无法解析到 header 条目`); stats[key] = 'MAIN MISSING'; }
      else { stats[key] = 'ok -> ' + resolved; }
    } catch (err) {
      problems.push(`require('${name}') 会失败: ${mp} ${err.message}`); stats[key] = 'BROKEN';
    }
  }

  return { ok: problems.length === 0, problems, stats };
}

function printReport(result, title) {
  console.log(`\n== ${title || '校验'} ${result.ok ? '通过' : '失败'} ==`);
  for (const [k, v] of Object.entries(result.stats)) console.log(`   ${k}: ${v}`);
  if (!result.ok) {
    console.log('   问题:');
    for (const p of result.problems) console.log('     - ' + p);
  }
}

module.exports = {
  readAsarHeader, flatten, headerDirs, dataOrderOf, walkDisk,
  copyRange, readSlice, sliceEqualsFile,
  buildHeaderBlock, sha256, sha256File, ensureUtf8Console,
  verifyAsar, printReport,
};
