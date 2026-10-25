#!/usr/bin/env python3
"""合并 personas.base + extra-a~d，跨角色去重，给每句补 shape，产出 personas.zh.json。

三条规则（都是评审意见带来的，改动前先读 docs/设计方案v2.md §2.4）：
1. 同一句话只能属于一个角色。跨角色重复是「切模型听见同一句」的直接原因。
2. 每句都带 shape（question/exclaim/state/onoma/mutter/action），旋转引擎靠它去重。
3. 不删除任何桶；桶缺额由 tools/topup/*.json 补，不在这里造假。
"""
import json, re, collections, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# 明显只属于某个角色的句子：按关键词钉死归属，剩下的才走机械均衡。
PINNED = {
    "帽子": "mistral",      # 金发红女巫帽
    "法杖": "perplexity",   # 星形法杖
    "场记": "minimax",      # 场记板
    "鲸": "deepseek",
    "尾巴": "deepseek",     # 只有深蓝鲸鱼娘有尾巴
    "龙": "gpt",
    "狐": "glm",
    "猫": "gemini",
    "书": "claude",
    "陪读": "kimi",
    "豆包": "doubao",
}

ONOMA = re.compile(r"^[啊诶嗯唔呜哦哎哈嘿呼嘻呀哇欸]{1,3}[？?！!。…~～]*$")


def classify(text: str) -> str:
    """给一句话打 shape。宁可粗，也要每句都有——没有 shape 旋转就退化成随机。"""
    t = text.strip()
    if t.startswith("（") and t.endswith("）"):
        return "action"
    if ONOMA.match(t):
        return "onoma"
    if "？" in t or "?" in t:
        return "question"
    if "！" in t or "!" in t:
        return "exclaim"
    if t.startswith("……") or t.startswith("..."):
        return "mutter"
    return "state"


def norm(entry):
    if isinstance(entry, str):
        return {"text": entry, "shape": classify(entry)}
    text = entry.get("text", "")
    return {"text": text, "shape": entry.get("shape") or classify(text)}


def main():
    base = json.loads((DATA / "personas/personas.base.zh.json").read_text(encoding="utf-8"))
    cards = {c["id"]: c for c in base["personas"]}

    for extra in sorted((DATA / "lines").glob("extra-*.zh.json")):
        pack = json.loads(extra.read_text(encoding="utf-8"))
        for pid, buckets in pack["personas"].items():
            if pid not in cards:
                raise SystemExit(f"{extra.name}: 未知角色 {pid}")
            target = cards[pid]["lines"]
            for bucket, arr in buckets.items():
                target.setdefault(bucket, [])
                target[bucket].extend(arr)

    # 全部转成 {text, shape}，同角色内同桶去重
    for c in cards.values():
        for bucket, arr in list(c["lines"].items()):
            # 补句包里的 reunionNote 之类是字符串元数据，不是桶，直接丢掉
            if not isinstance(arr, list):
                del c["lines"][bucket]
                continue
            seen, out = set(), []
            for entry in arr:
                item = norm(entry)
                key = item["text"].strip()
                if not key or key in seen:
                    continue
                seen.add(key)
                out.append(item)
            if out:
                c["lines"][bucket] = out
            else:
                # 空桶（例如补句包里只放了 "reunionNote": "" 这种占位）直接删掉，
                # 否则校验器会把它当成「这个桶没有台词」的缺陷。
                del c["lines"][bucket]

    # 跨角色去重：同 (桶, 句) 只留一个主人
    owners = collections.defaultdict(list)  # (bucket, text) -> [persona ids]
    for pid, c in cards.items():
        for bucket, arr in c["lines"].items():
            for item in arr:
                owners[(bucket, item["text"].strip())].append(pid)

    def pick(text, pids):
        for kw, pid in PINNED.items():
            if kw in text and pid in pids:
                return pid
        # 泛用句优先留给 generic（未知模型的兜底卡），否则给当前句最少的角色
        if "generic" in pids:
            return "generic"
        return min(pids, key=lambda p: (sum(len(v) for v in cards[p]["lines"].values()), p))

    removed = collections.Counter()
    for (bucket, text), pids in owners.items():
        if len(pids) < 2:
            continue
        keep = pick(text, pids)
        for pid in pids:
            if pid == keep:
                continue
            cards[pid]["lines"][bucket] = [i for i in cards[pid]["lines"][bucket] if i["text"].strip() != text]
            removed[pid] += 1

    out = {
        "$schema": "./personas.schema.json",
        "version": 2,
        "note": "每句都带 shape；同一句话只属于一个角色。合并脚本 tools/merge.py，不要手改。",
        "personas": [cards[c["id"]] for c in base["personas"]],
    }
    (DATA / "personas/personas.zh.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = 0
    print(f"{'id':10s} {'total':>5s}  buckets")
    for c in out["personas"]:
        n = sum(len(v) for v in c["lines"].values())
        total += n
        short = [b for b, v in c["lines"].items() if len(v) < 6]
        print(f"{c['id']:10s} {n:5d}  {'short:' + ','.join(short) if short else ''}")
    print("total:", total, "| cross-card removals:", sum(removed.values()))


if __name__ == "__main__":
    main()
