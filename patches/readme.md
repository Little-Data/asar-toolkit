# 本目录为补丁定义文件目录

## 新增补丁

名称最好不要有空格

新建 `<`名称`>.json`：

```
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

## 目前的补丁列表

| 名称 | 相关软件 | 对应版本 | 链接 | 说明 |
| --- | :--- | --- | --- | --- |
| remove-diarization-model-size-check | SmartSub | V3.12.2 | https://github.com/buxuku/SmartSub | 移除角色分离模型文件的大小精确校验，改为只检查文件是否存在，避免模型更新后无法下载使用 |
