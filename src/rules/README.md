# 作者规则格式（v1）

在角色卡**主绑定世界书**中增加标题恰为 `[DWM Rules]` 的条目，正文写 JSON：

```json
{
  "format": "dwm-rules",
  "version": 1,
  "naturalLanguage": "叙事铁律不要改写；旧住址可以随明确剧情更新。",
  "script": "when entry.title contains \"变量\" => lock;\nwhen entry.sourceUID == \"17\" => maxChars 500;\nwhen entry.kind == \"npc\" and not entry.constant == true => always;"
}
```

插件发现配置时只解析 JSON，不执行世界书模板或 EJS。规则条目即使原生禁用仍可识别；插件应从建档与正文资料中排除它，并保持原书本身不变。多个规则条目按原书顺序合并；`lock` 和 `always` 只能增加约束，多个 `maxChars` 取最小值。格式或脚本错误会给出条目 UID 或脚本行列，不静默忽略。

每句语法：`when <条件> => <操作>;`。条件允许 `and`、`or`、`not` 与括号；比较只允许 `==`、`!=`、`contains`。字段只有 `entry.id`、`entry.title`、`entry.kind`、`entry.constant`、`entry.sourceUID`（可省略 `entry.`）。文本使用 JSON 双引号字符串，`constant` 用布尔值。操作仅 `lock`、`maxChars <1–100000>`、`always`、`trigger`、`gate`；没有 `unlock`。`always` 表示每轮必选，不能越过原生禁用、角色、隐藏和进度限制。`trigger` 表示该条目的原书关键词出现在玩家本轮输入或最近 4 楼正文中时，程序直接选入，不经过模型判断；适合剧情状态机、事件大纲这类靠关键词或标签点亮的条目。`gate` 是它的反面：该条目的原书关键词没有出现在同一段文字（玩家本轮输入与最近 4 楼正文）里时，不进入本轮选材目录，模型选不到它，也不占选材名额；同时命中 `always` 时以 `gate` 为准。原书蓝灯和玩家设为常驻（包括玩家手动晋升的重要人物）的条目照常发送，不受 `gate` 限制；初始化扫描时被判为重要、只因此算作常驻的条目，在 `gate` 下按按需处理，资料页的灯也显示按需；没有原书关键词的条目在 `gate` 下永远不会被选。`trigger` 与 `gate` 同时使用时，条目完全由关键词决定：出现就发，不出现就不发。自然语言要求除用于初始化分类外，也会作为 authorGuidance 交给发送前的选材参考。脚本不支持函数、循环、变量、宿主对象、网络或任意 JavaScript。

`discoverRules(rawEntries)` 返回 `{ naturalLanguage, script, configEntryUids }`；调用方只传主绑定原书的原始条目，并用 `configEntryUids` 排除配置条目的动态建档及模型上下文。`compileRules(script)` 返回可序列化 AST；`evaluateRules(ast, entry)` 返回 `{ locked, maxChars, always, trigger, gate }`；`applyRules(entries, ast)` 返回 `{ entries, constraints }`，其中锁定条目的所有片段均变为不可写。初始化时将自然语言提供给分类 Agent，再把脚本约束施加到结果；后置输入过滤和提交校验必须继续执行锁定权限。`buildRuleDocument` 与 `formToScript` 供可视化工具构造、校验配置。
