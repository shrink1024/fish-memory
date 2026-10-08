# 源码与发行包

源码包是筛选后的工作树快照，不带本地开发仓库的Git历史。最小安装包只用于安装。发行仓库为 [shrink1024/fish-memory](https://github.com/shrink1024/fish-memory)，当前版本为实验性 alpha 候选；许可证尚未确定。

## 本地构建

开发与程序测试使用Node.js 22或更新版本，没有运行期npm依赖。在源码目录运行：

```sh
npm test
npm run check
npm run build
```

安装构建生成于 `.local/build/st-dynamic-world-memory`。构建会先校验源文件和版本，再删除并重新创建该目标，避免旧文件残留；不会自动部署到酒馆。复制整个目录即可独立安装。

生成源码与离线安装ZIP：

```sh
node scripts/release.mjs
```

该步骤需要命令行 `zip`，先运行程序测试和入口／语法检查，再生成 `.local/release/版本/`。输出包括安装目录、筛选源码目录、两个ZIP、`SHA256SUMS`与`release.json`。源码和安装目录各自包含 `RELEASE-MANIFEST.json`，列明每个文件的相对路径、字节数和SHA-256；清单不含自身以免循环。包中没有签名，校验和只用于检测文件是否变化。

macOS可在输出目录执行 `shasum -a 256 -c SHA256SUMS`；Linux可使用 `sha256sum -c SHA256SUMS`。Windows可用PowerShell `Get-FileHash 文件名 -Algorithm SHA256` 与清单比较。解压后还应按包内的 `RELEASE-MANIFEST.json` 逐文件校验，并从源码包再构建，比较运行文件。

## 两份清单

实际白名单在 `scripts/build.mjs`，不是“除去几个敏感目录后复制所有内容”。

| 内容 | 安装包 | 源码包 |
| --- | --- | --- |
| manifest、入口、样式、明确列出的src文件 | 有 | 有 |
| recovery.html离线旧窗口恢复工具 | 有 | 有 |
| README、INSTALL、兼容说明、变更说明、反馈模板 | 有 | 有 |
| package、构建／检查／发行／演示脚本、demo | 无 | 有 |
| test目录顶层的 `*.test.js` | 无 | 有 |
| 本文（源码与构建说明） | 无 | 有 |
| 尚在修改的公测文案、HTML指南与内部发行检查表 | 无 | 无 |
| LICENSE | 作者确定并创建后才包含 | 同左 |
| 开发历史、内部交接、上游研究、截图、模型回放素材、私密日志、.local、.git | 无 | 无 |

新增运行文件时要显式更新白名单，并确认包内相对导入完整。测试文件须保持合成数据，不可把真实聊天、密钥或外部私有路径写入测试。新增文档也应先确定公开用途后再加入。

## 发行仓库

最小包白名单不会约束Git克隆。发行仓库 [shrink1024/fish-memory](https://github.com/shrink1024/fish-memory) 从筛选后的源码目录建立；不要直接推送原开发仓库，也不要靠更换当前Git用户名来清除旧提交里的身份信息。源码包中的 `private: true` 防止意外npm发布，不是开源许可证。当前未添加 `LICENSE`，也未授予开源许可证。

生成包不创建外部仓库、tag或Release，不上传、不提交Git，也不覆盖任何酒馆安装或存档。本轮独立宿主验收结果见 [变更说明](CHANGELOG.md)。本地HTTP Git安装／更新验证不等于公网仓库发布；具体版本的标签、Release与下载包须分别核对，生成候选包本身不代表已上传。
