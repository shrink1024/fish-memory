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

每句语法：`when <条件> => <操作>;`。条件允许 `and`、`or`、`not` 与括号；比较只允许 `==`、`!=`、`contains`。字段只有 `entry.id`、`entry.title`、`entry.kind`、`entry.constant`、`entry.sourceUID`（可省略 `entry.`）。文本使用 JSON 双引号字符串，`constant` 用布尔值。操作仅 `lock`、`maxChars <1–100000>`、`always`；没有 `unlock`。`always` 表示插件选材偏好，不能越过原生禁用、角色、隐藏和进度限制。脚本不支持函数、循环、变量、宿主对象、网络或任意 JavaScript。

`discoverRules(rawEntries)` 返回 `{ naturalLanguage, script, configEntryUids }`；调用方只传主绑定原书的原始条目，并用 `configEntryUids` 排除配置条目的动态建档及模型上下文。`compileRules(script)` 返回可序列化 AST；`evaluateRules(ast, entry)` 返回 `{ locked, maxChars, always }`；`applyRules(entries, ast)` 返回 `{ entries, constraints }`，其中锁定条目的所有片段均变为不可写。初始化时将自然语言提供给分类 Agent，再把脚本约束施加到结果；后置输入过滤和提交校验必须继续执行锁定权限。`buildRuleDocument` 与 `formToScript` 供可视化工具构造、校验配置。
