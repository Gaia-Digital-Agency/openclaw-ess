#!/usr/bin/env python3
"""
Fetch a Google Doc body as Markdown.

Auth strategy (auto-detects best available):
  1. If /opt/.openclaw-ess/credentials/google-user-token.json exists, use OAuth
     user credentials (run oauth-setup.py once to create it).
  2. Else fall back to the service account at
     /opt/.openclaw-ess/credentials/gda-viceroy-vertex.json.
     The doc must be SHARED with the SA email:
         292070531785-compute@developer.gserviceaccount.com
     Easiest: share the parent Drive folder with the SA as Viewer.

Usage:
  ./read-google-doc.py <doc-url-or-id>
  ./read-google-doc.py --json <doc-url-or-id>     # full structured JSON
  ./read-google-doc.py --markdown <doc-url-or-id> # default — markdown text

Exit 0: doc fetched. Exit 2: permission denied (share doc with SA).
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
from pathlib import Path

CRED_USER = Path("/opt/.openclaw-ess/credentials/google-user-token.json")
CRED_SA = Path("/opt/.openclaw-ess/credentials/gda-viceroy-vertex.json")

SCOPES = [
    # Match the existing /var/www/gdrive token exactly so refresh works.
    # 'drive' is a superset that covers reading Docs via the Docs API.
    "https://www.googleapis.com/auth/drive",
]


def parse_doc_id(url_or_id: str) -> str:
    """Extract Google Doc ID from URL or accept raw ID."""
    m = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url_or_id)
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{20,}$", url_or_id):
        return url_or_id
    raise ValueError(f"Could not extract doc ID from: {url_or_id}")


def get_credentials():
    """Prefer user OAuth token; fall back to service account."""
    if CRED_USER.exists():
        from google.oauth2.credentials import Credentials  # type: ignore
        from google.auth.transport.requests import Request  # type: ignore

        creds = Credentials.from_authorized_user_file(str(CRED_USER), SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            CRED_USER.write_text(creds.to_json())
        return creds, "user-oauth"
    if CRED_SA.exists():
        from google.oauth2 import service_account  # type: ignore

        creds = service_account.Credentials.from_service_account_file(
            str(CRED_SA), scopes=SCOPES
        )
        return creds, "service-account"
    raise RuntimeError(
        f"No credentials found. Need either {CRED_USER} (run oauth-setup.py) "
        f"or {CRED_SA} (then share docs with the SA email)."
    )


def get_oauth_user_email(creds) -> str | None:
    """Best-effort lookup of the email tied to current OAuth credentials."""
    try:
        from googleapiclient.discovery import build  # type: ignore
        oauth2 = build("oauth2", "v2", credentials=creds, cache_discovery=False)
        info = oauth2.userinfo().get().execute()
        return info.get("email")
    except Exception:
        return None


def fetch(doc_id: str):
    from googleapiclient.discovery import build  # type: ignore
    from googleapiclient.errors import HttpError  # type: ignore

    creds, source = get_credentials()
    service = build("docs", "v1", credentials=creds)
    try:
        doc = service.documents().get(documentId=doc_id).execute()
        return doc, source
    except HttpError as e:
        if e.status_code == 403:
            sa_email = "292070531785-compute@developer.gserviceaccount.com"
            # Token was issued for ai@gaiada.com (carried over from /var/www/gdrive).
            # Userinfo API requires extra scope; fall back to known mapping.
            who = get_oauth_user_email(creds) if source == "user-oauth" else None
            if source == "user-oauth" and not who:
                who = "ai@gaiada.com"
            print(
                f"PERMISSION DENIED on doc {doc_id}.\n"
                f"  Auth source: {source}\n"
                + (f"  OAuth user: {who or 'unknown'}\n" if source == "user-oauth" else "")
                + (
                    f"  Fix: share the doc (or its parent folder) with that user:\n"
                    f"      {who}\n"
                    f"  …as Viewer or higher.\n"
                    if source == "user-oauth"
                    else f"  Fix: share the doc with the SA email:\n"
                         f"      {sa_email}\n"
                         f"  …as Viewer. Or run oauth-setup for user OAuth.\n"
                ),
                file=sys.stderr,
            )
            sys.exit(2)
        raise


def doc_to_markdown(doc) -> str:
    """Render the most useful fields of a Google Docs document to markdown."""
    out: list[str] = []
    title = doc.get("title", "")
    if title:
        out.append(f"# {title}\n")

    body = doc.get("body", {}).get("content", [])
    for el in body:
        para = el.get("paragraph")
        if not para:
            continue
        style = (para.get("paragraphStyle", {}) or {}).get("namedStyleType", "")
        runs = []
        for r in para.get("elements", []):
            tr = r.get("textRun")
            if not tr:
                continue
            text = tr.get("content", "")
            ts = tr.get("textStyle", {}) or {}
            if ts.get("bold"):
                text = f"**{text}**"
            if ts.get("italic"):
                text = f"_{text}_"
            link = (ts.get("link") or {}).get("url")
            if link:
                text = f"[{text.strip()}]({link})"
            runs.append(text)
        line = "".join(runs).rstrip("\n")
        if not line.strip():
            out.append("")
            continue
        if style == "TITLE":
            out.append(f"# {line}")
        elif style == "HEADING_1":
            out.append(f"## {line}")
        elif style == "HEADING_2":
            out.append(f"### {line}")
        elif style == "HEADING_3":
            out.append(f"#### {line}")
        else:
            out.append(line)
    return "\n".join(out).strip() + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("doc")
    ap.add_argument("--json", action="store_true", help="emit full Docs API JSON")
    ap.add_argument("--markdown", action="store_true", help="emit markdown (default)")
    args = ap.parse_args()

    doc_id = parse_doc_id(args.doc)
    doc, source = fetch(doc_id)

    if args.json:
        print(json.dumps(doc, indent=2, ensure_ascii=False))
        return

    md = doc_to_markdown(doc)
    print(md)


if __name__ == "__main__":
    main()
