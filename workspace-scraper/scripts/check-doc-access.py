#!/usr/bin/env python3
"""
Check Google Drive access for the OAuth user (ai@gaiada.com).

For every Draft Link in the inbox xlsx, report whether ai@gaiada.com can read it.
Outputs a clear actionable list — which docs are ready and which need sharing.

Usage:
  ./check-doc-access.py                 # check latest xlsx in inbox
  ./check-doc-access.py path/to.xlsx    # specific file
"""
from __future__ import annotations
import json
import os
import re
import sys
from pathlib import Path

INBOX = Path("/opt/.openclaw-ess/inbox/articles")
XLSX_READER = "/opt/.openclaw-ess/workspace-scraper/scripts/read-articles-xlsx.py"


def parse_doc_id(url: str) -> str | None:
    if not url:
        return None
    m = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url)
    return m.group(1) if m else None


def main():
    import subprocess

    xlsx_path = sys.argv[1] if len(sys.argv) > 1 else None
    args = ["python3", XLSX_READER]
    if xlsx_path:
        args.append(xlsx_path)
    rows = json.loads(subprocess.check_output(args)).get("rows", [])

    # Auth
    from google.oauth2.credentials import Credentials  # type: ignore
    from google.auth.transport.requests import Request  # type: ignore
    from googleapiclient.discovery import build  # type: ignore
    from googleapiclient.errors import HttpError  # type: ignore

    creds = Credentials.from_authorized_user_file(
        "/opt/.openclaw-ess/credentials/google-user-token.json",
        ["https://www.googleapis.com/auth/drive"],
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())

    docs = build("docs", "v1", credentials=creds, cache_discovery=False)

    accessible: list[dict] = []
    blocked: list[dict] = []
    nodoc: list[dict] = []

    for r in rows:
        link = r.get("draft_link") or ""
        doc_id = parse_doc_id(link)
        if not doc_id:
            nodoc.append(r)
            continue
        try:
            d = docs.documents().get(documentId=doc_id, fields="title").execute()
            accessible.append({"row": r, "doc_id": doc_id, "title_in_doc": d.get("title", "")})
        except HttpError as e:
            blocked.append({"row": r, "doc_id": doc_id, "status": e.status_code})

    print(f"\n=== Google Doc access for ai@gaiada.com ===")
    print(f"Total xlsx rows:   {len(rows)}")
    print(f"  ✓ accessible:    {len(accessible)}")
    print(f"  ✗ blocked (403): {sum(1 for b in blocked if b['status'] == 403)}")
    print(f"  ✗ other error:   {sum(1 for b in blocked if b['status'] != 403)}")
    print(f"  — no draft link: {len(nodoc)}")

    if accessible:
        print(f"\n--- ✓ Ready to fetch ({len(accessible)}): ---")
        for a in accessible[:10]:
            t = a["row"].get("title", "")[:55]
            print(f"  {a['doc_id'][:28]}…  {t}")
        if len(accessible) > 10:
            print(f"  … and {len(accessible) - 10} more")

    if blocked:
        print(f"\n--- ✗ Need sharing ({len(blocked)}): ---")
        print("    Share with ai@gaiada.com (Viewer is enough):")
        for b in blocked[:10]:
            t = b["row"].get("title", "")[:55]
            print(f"  https://docs.google.com/document/d/{b['doc_id']}/edit")
            print(f"    └─ {t}")
        if len(blocked) > 10:
            print(f"\n  … and {len(blocked) - 10} more")

    print("")
    sys.exit(0 if len(blocked) == 0 else 2)


if __name__ == "__main__":
    main()
