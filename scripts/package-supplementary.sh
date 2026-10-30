#!/usr/bin/env bash
# 打包 TMLR 补充材料:可离线复算全部数字的最小集合。
#
# ## 为什么需要一个脚本而不是手动 zip
#
# 双盲是硬性门槛,而泄漏身份的路径不止作者名:git 历史里有提交者邮箱,
# 分支名含用户名,构建产物可能嵌入绝对路径(含 $HOME 下的用户名),
# node_modules 里有本机路径。手动打包几乎必然漏掉其中之一。
#
# 本脚本只纳入白名单路径,并在打包后**重新扫描**产出物——白名单防遗漏,
# 扫描防白名单本身写错。
#
# ## 为什么带上 results/
#
# 论文声明"每个数字可零 API 成本复算"。那条声明的载体就是
# results/records.jsonl 加 results/transcripts/,缺了它们声明即失效。
# 实测 126 份 transcript 不含真实型号名与端点主机名(model 字段记为
# small/mid 这样的档位标签),故可原样提交。

set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-supplementary.zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ── 白名单:源码 + 测试 + 数据 + 构建配置 ────────────────────────────────────
mkdir -p "$STAGE/supplementary"
for path in \
  packages \
  results/records.jsonl \
  results/transcripts \
  results/grid-rootscored/README.md \
  results/pilot-v1/README.md \
  package.json \
  tsconfig.base.json \
  vitest.config.ts \
  GRAPH_CONTROLLER.md \
  SECURITY_REVIEW.md
do
  if [ -e "$path" ]; then
    mkdir -p "$STAGE/supplementary/$(dirname "$path")"
    cp -R "$path" "$STAGE/supplementary/$(dirname "$path")/"
  fi
done

# 构建产物与依赖不入包:体积大、且 dist/ 里可能嵌入含用户名的绝对路径。
find "$STAGE/supplementary" -type d \( -name node_modules -o -name dist \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/supplementary" -name "*.tsbuildinfo" -delete 2>/dev/null || true

cat > "$STAGE/supplementary/README.md" <<'DOC'
# Supplementary material

Anonymised artifact for the submitted manuscript.

## Reproducing the reported numbers without API access

Every number in the results section derives from `results/records.jsonl`
(118 cells) and can be recomputed offline:

```sh
npm install
npm run build
npm test            # 740 tests, fully offline
```

The analysis functions are in `packages/bench/src/metrics.ts`:
`aggregateByCondition`, `pairedCompare`, `paretoFront`, `sweepObjective`,
`digestConsistency`.

## Verifying the determinism claim yourself

`results/transcripts/` holds the recorded model responses for all 126 attempted
cells. `ReplayModel` serves them back by request hash, so a run can be replayed
with no network access:

```
packages/node/test/replay-determinism.integration.test.ts
```

records one run and replays it under three concurrency limits crossed with
three artificially shuffled completion orders, asserting a single snapshot
digest. Replay is fail-closed: a request absent from the transcript throws
rather than being fabricated, so a divergent run surfaces instead of being
papered over.

## Re-scoring under a different rule

Transcripts contain full request/response pairs, so quality can be recomputed
under a different scorer without re-running anything. We used this ourselves:
the archived `results/grid-rootscored/README.md` documents a scoring bug found
this way, including the per-arm bias it introduced.

## What is not included

- `node_modules/` and `dist/` — run `npm install && npm run build`.
- API credentials. Live runs read a key from an environment variable named in
  `packages/bench/src/models.ts`; no key is present in this bundle.
- The excluded frontier tier. Section 5 explains why it could not be compared
  fairly through the available endpoint.

## Note on the code-generation scorer

`packages/bench/src/scorers/codegen.ts` executes model-generated code in a
subprocess with network and subprocess modules blocked, wall-clock and memory
limits, a whitelisted environment, and a disposable working directory. This is
process isolation, not a sandbox: the child runs as the invoking user. Use a
container or VM for untrusted payloads.
DOC

# ── 打包 ────────────────────────────────────────────────────────────────────
( cd "$STAGE" && zip -qr "$OUT" supplementary -x '*.DS_Store' )
mv "$STAGE/$OUT" .

# ── 打包后重新扫描:白名单防遗漏,扫描防白名单写错 ──────────────────────────
echo "=== anonymity scan of $OUT ==="
LEAK=0
for pat in mashiro Mashiromaster jdcloud modelservice "$(git config user.email 2>/dev/null || echo __none__)"; do
  [ "$pat" = "__none__" ] && continue
  if unzip -p "$OUT" '*' 2>/dev/null | grep -qi -- "$pat"; then
    echo "  LEAK: '$pat' present"
    LEAK=1
  fi
done
# 绝对路径泄漏(含 $HOME 的用户名)
if unzip -p "$OUT" '*' 2>/dev/null | grep -qE "/Users/[a-z]+/"; then
  echo "  LEAK: absolute /Users/<name>/ path present"
  LEAK=1
fi
[ "$LEAK" -eq 0 ] && echo "  clean"

echo "=== bundle ==="
ls -lh "$OUT" | awk '{print "  size:", $5}'
unzip -l "$OUT" | tail -1 | awk '{print "  files:", $2}'
exit "$LEAK"
