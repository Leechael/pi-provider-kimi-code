# Tool Schema Dedup — 解决 Moonshot 单 tool schema 15KB 限制

## Context

Moonshot API 对每个 tool 的 `function.parameters` JSON Schema 有 ~15KB 的硬限制（字面大小，不展开 `$ref`）。`pi-subagents` 的 `subagent` tool schema 为 25KB+，其中 `acceptance` 被完整重复 5 次（~10KB），导致请求被 400 拒绝。

已验证：

- 限制是单个 tool 的 `function.parameters`，非总量（146KB 总量通过）
- `function.description` 不计入限制（50KB 通过）
- Moonshot 支持 `$ref` + `$defs`，按字面大小检查，不展开 `$ref`
- 支持嵌套引用、递归自引用、`anyOf`/array items 内的 `$ref`
- dedup 后 24KB → 13.7KB，Kimi 接受

相关 issue：#16、#21（#19 已确认为重复）

## 方案

在 `onPayload` 中对超限 tool 的 `parameters` 做 `$ref` 提取，将重复子 schema 合并到 `$defs`。缓存结果避免每次请求重复计算。

### 文件变更

#### 1. 新建 `src/schema-dedup.ts`

核心算法 + 缓存逻辑。

**`deduplicateSchema(schema: object): object`**

- 输入：单个 tool 的 `function.parameters`（JSON Schema object）
- 多轮扫描（最多 5 轮），找出 >=50 bytes 且出现 >=2 次的子 schema
- 按大小降序处理，大块优先。跳过已被替换子树内的路径
- 计算 net savings（`(count-1) * size - overhead`），仅在正收益时提取
- 提取到 `$defs`，替换为 `{ $ref: "#/$defs/dN" }`
- 如果 schema 已有 `$defs`，合并时避免 key 冲突
- 确定性输出：同输入同输出

**`optimizeToolSchemas(tools: unknown[]): unknown[]`**

- 遍历 tools 数组，检查每个 tool 的 `function.parameters` 序列化大小
- 超过阈值（14,000 bytes，留 ~1KB margin）的 tool 调用 `deduplicateSchema`
- 返回新数组（未超限的 tool 保持原引用）

**缓存**

- 模块级缓存：`lastFingerprint` + `lastResult`
- fingerprint = tool 名称列表 join（`tools.map(t => t.function.name).join(",")`）
- 命中时直接返回缓存的 tools 数组，零计算
- tools 变化（extension toggle、reload）时 fingerprint 变化，触发重新计算

#### 2. 修改 `src/payload.ts`

在 `applyKimiPayloadMutations` 中，`normalizeOpenAIToolSchemas` 之后加一步：

```
// 现有步骤
normalizeOpenAIAssistantToolCalls(payload);
normalizeOpenAIToolSchemas(payload);      // 填充缺失的 type

// 新增步骤
optimizeOversizedToolSchemas(payload);     // $ref dedup 超限 schema
```

对所有协议路径生效（Moonshot 的 schema size 限制与协议无关）。

#### 3. 测试 `tests/schema-dedup.test.ts`

- **fixture 测试**：加载 `fixtures/.../captures/` 中的真实 subagent schema，验证 dedup 后大小 < 15KB
- **等价性测试**：用 ajv 对比 dedup 前后的 schema，验证相同输入的 validate 结果一致
- **缓存测试**：连续调用 `optimizeToolSchemas`，验证第二次返回缓存引用
- **边界情况**：
  - 无超限 tool → 原样返回
  - schema 已有 `$defs` → 正确合并
  - dedup 后仍超限 → 返回 dedup 结果（尽力而为，不 drop tool）
  - 无重复子 schema → 原样返回

#### 4. 集成测试脚本

更新 `fixtures/pi-subagents-kimi-schema-repro/scripts/` 中已有的脚本，增加 dedup 验证：

- `replay-capture.mjs` 增加 `--dedup` 选项，应用 dedup 后重放
- 或新建 `test-dedup-replay.mjs`

### 不做的事

- 不砍 `function.description`（不计入限制）
- 不 drop 超限 tool（会影响 agent 功能）
- Anthropic 协议路径同样适用（Moonshot 的 schema size 限制与协议无关）
- 不做 description 截断作为 fallback（dedup 已经足够，13.7KB < 15KB）

### 验证

1. `prek`（lint + type check + 单元测试）
2. fixture replay：用 `replay-capture.mjs` 对真实 subagent schema 做 dedup 后发到 Kimi，确认 200
3. 用 ajv 验证 dedup 前后 schema 语义等价
4. 正常 tool（read/bash/edit/write 都在 1.3KB 以下）不受影响——验证 dedup 不修改未超限 tool
