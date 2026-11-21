# asar-toolkit

通用 Electron asar 工具：**解包 → 补丁 → 打包 + 校验**。不绑定任何具体应用，可用于任意 Electron 应用的 asar 修改与回炉；同时内置了针对“重新打包后启动失败”这类典型故障的检测。

## 文件

| 文件 | 作用 |
|---|---|
| `unpack.js` | 解包 asar（含 `unpacked` 条目），生成 manifest |
| `patch.js` | 对解包文件做可重复的文本补丁（应用/回退/检查），定义在 `patches/*.json` |
| `pack.js` | 按 manifest 还原 header 并打包，打包后自动完整校验 |
| `verify.js` | 独立校验任意 asar |
| `lib.js` | 共享实现（header 解析、分块拷贝、校验规则） |
| `patches/` | 补丁定义（JSON） |

## 快速开始
### 环境准备

安装 [nodejs](https://nodejs.org/zh-cn/download) 最好是最新稳定版。


### 解包

`--force` 覆盖已有目录；unpacked 条目默认从 `<asar>.unpacked` 取，asar 文件名不是 app.asar 时用 `--unpacked-dir` 指定该目录

```bat
node unpack.js "D:\path\resources\app.asar" "D:\work\app-unpacked"
node unpack.js "D:\path\resources\app.asar" "D:\work\app-unpacked" --unpacked-dir "D:\path\resources\app.asar.unpacked"
```

### 打补丁

自动做语法检查；`--check` 只看状态，`--revert` 回退，`--list` 看清单

```bat
node patch.js "D:\work\app-unpacked"
node patch.js "D:\work\app-unpacked" --check
node patch.js "D:\work\app-unpacked" --revert
```

### 打包 + 校验

校验不通过则退出码非 0；`--require` 预检依赖模块可解析

```bat
node pack.js "D:\work\app-unpacked" "D:\path\resources\app.asar" --require ffmpeg-static
```

独立校验（不打包）

```bat
node verify.js "D:\path\resources\app.asar" --dir "D:\work\app-unpacked" --require ffmpeg-static
```

退出码：`0` 成功 / `1` 校验或补丁失败 / `2` 参数错误。

## manifest 是什么

`unpack.js` 会在输出目录旁生成 `<目录>.manifest.json`，内容是**原 asar 的完整 header**（目录结构、条目顺序、`unpacked` / `executable` 标志、原数据顺序）。`pack.js` 用它还原 header，只从磁盘读取文件内容并按磁盘尺寸重算 offset——所以：

- 补丁改变了文件大小（如 `background.js` 少了 31 字节）没有问题；
- `unpacked` 标志原样保留，**被标记 unpacked 的文件不会写入 asar**，运行时仍由 `<输出>.asar.unpacked` 提供（沿用原版逻辑）；
- 若 manifest 丢失，可用 `pack.js --from-asar <原版asar>` 重新生成。

## 新增补丁

在 `patches/` 下新建 `<名字>.json`：

```json
{
  "id": "my-patch",
  "description": "做了什么",
  "target": "app/background.js（要打补丁的文件）",
  "contains": "用于确认文件类型的特征串",
  "old": "应用前的精确片段",
  "new": "应用后的精确片段",
  "note": "注释适用的构建/版本"
}
```

- `old` / `new` 必须与目标文件**逐字符一致**（压缩产物中的变量名会随构建变化，应用升级后需重新提取）。
- `node patch.js <目录> --list` 查看所有补丁在目标上的状态；`--id <id>` 只处理某一个（找不到模式会报失败）。

## 限制与注意

- `link`（符号链接）条目：`unpack.js` 会明确报错不支持（Windows 上无法可靠还原）；`pack.js` / `verify.js` 会原样保留/记录。
- 校验是严格的：`--dir` 比对要求目录与 asar 条目完全一致（包含 `unpacked` 文件）。
- 建议保留原版 asar 副本作为回滚点。