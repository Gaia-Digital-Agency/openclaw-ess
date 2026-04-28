#!/usr/bin/env python3
"""
Process-inbox: turn the Drive xlsx tracker + accessible draft Docs into
article-ready records for Elliot's downstream pipeline (Copywriter → Imager
→ SEO → Web Manager → Payload).

Pipeline:
  1. (optional) pull-xlsx-from-drive: fetches latest xlsx from Drive.
  2. read-articles-xlsx: parses tracker rows.
  3. For each row with a Draft Link:
       - try read-google-doc; on 403 fall back to row metadata only.
  4. Emit one JSON record per row, marked `body_source` = "draft" | "metadata".
     Copywriter is expected to expand `body_source=metadata` rows from the
     SEO Title + Meta Description + Blog Topic + Keywords.

The integrated processor never skips a row. Sharing a Doc with
`ai@gaiada.com` later upgrades that row from `metadata` to `draft` on the
next run, with zero code changes.

Usage:
  ./process-inbox.py                    # default: latest xlsx in inbox
  ./process-inbox.py --pull             # pull from Drive first
  ./process-inbox.py --month=Apr        # one sheet
  ./process-inbox.py --status=draft     # only Draft rows
  ./process-inbox.py --out=/tmp/q.json  # write to file
"""
from __future__ import annotations
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path("/opt/.openclaw-ess/workspace-scraper/scripts")
INBOX = Path("/opt/.openclaw-ess/inbox/articles")


def parse_doc_id(url: str) -> str | None:
    if not url:
        return None
    m = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url)
    return m.group(1) if m else None


def run(cmd: list[str], capture: bool = True) -> tuple[int, str, str]:
    r = subprocess.run(cmd, capture_output=capture, text=True)
    return r.returncode, r.stdout or "", r.stderr or ""


def fetch_doc_md(url: str) -> tuple[str | None, str]:
    """Return (markdown, source_label). source_label in {draft, metadata, error}."""
    code, out, err = run(["python3", str(ROOT / "read-google-doc.py"), url])
    if code == 0 and out.strip():
        return out, "draft"
    if code == 2:
        return None, "metadata"  # 403 expected when not shared
    return None, "metadata"  # any other error → fall back


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pull", action="store_true", help="pull-xlsx-from-drive first")
    ap.add_argument("--month", help="filter to one month sheet")
    ap.add_argument("--status", help="filter by Article Status substring")
    ap.add_argument("--out", help="write JSON to file (else stdout)")
    args = ap.parse_args()

    if args.pull:
        code, out, err = run(["python3", str(ROOT / "pull-xlsx-from-drive.py")])
        print(out.strip(), file=sys.stderr) if out else None
        if code != 0:
            print(f"WARN: pull-xlsx-from-drive exited {code}: {err.strip()}", file=sys.stderr)

    reader_args = ["python3", str(ROOT / "read-articles-xlsx.py")]
    if args.month:
        reader_args += ["--month", args.month]
    if args.status:
        reader_args += ["--status", args.status]

    code, out, err = run(reader_args)
    if code != 0:
        print(f"reader failed: {err}", file=sys.stderr)
        sys.exit(1)
    rows = json.loads(out).get("rows", [])

    out_records: list[dict] = []
    counts = {"draft": 0, "metadata": 0}

    for r in rows:
        link = r.get("draft_link") or ""
        md, source = (None, "metadata")
        if parse_doc_id(link):
            md, source = fetch_doc_md(link)

        rec = {
            "month": r.get("month"),
            "row": r.get("row"),
            "title": r.get("title"),
            "slug": r.get("slug"),
            "topic_brief": r.get("topic_brief"),
            "meta_description": r.get("meta_description"),
            "keywords": r.get("keywords"),
            "writer": r.get("writer"),
            "article_status": r.get("article_status"),
            "guessed_area": r.get("guessed_area"),
            "guessed_topic": r.get("guessed_topic"),
            "draft_link": link,
            "body_source": source,                # "draft" | "metadata"
            "body_markdown": md,                  # filled only if source == "draft"
            "source_hash": f"xlsx:{r.get('month')}:row{r.get('row')}",  # idempotency
        }
        out_records.append(rec)
        counts[source] = counts.get(source, 0) + 1

    payload = {
        "count": len(out_records),
        "body_source_counts": counts,
        "records": out_records,
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False)

    if args.out:
        Path(args.out).write_text(text)
        print(
            f"wrote {args.out}: {len(out_records)} records "
            f"(draft={counts.get('draft', 0)}, metadata={counts.get('metadata', 0)})",
            file=sys.stderr,
        )
    else:
        print(text)


if __name__ == "__main__":
    main()
