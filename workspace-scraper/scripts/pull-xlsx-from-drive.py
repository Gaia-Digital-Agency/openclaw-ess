#!/usr/bin/env python3
"""
Pull the article-tracker xlsx from Google Drive into /opt/.openclaw-ess/inbox/articles/

Replaces sync-articles-inbox.sh once the local Mac directory is gone. The xlsx
is expected to live in Drive, shared with ai@gaiada.com (Viewer is enough).

Usage:
    ./pull-xlsx-from-drive.py
    ./pull-xlsx-from-drive.py --search "Essential Bali Proofread"
    ./pull-xlsx-from-drive.py --file-id <google-drive-file-id>
    ./pull-xlsx-from-drive.py --list   # show what xlsx files ai@gaiada.com can see

Env:
    DRIVE_XLSX_NAME  default: "Essential Bali Proofread.xlsx"
    INBOX_DIR        default: /opt/.openclaw-ess/inbox/articles
"""
from __future__ import annotations
import argparse
import io
import os
import sys
from pathlib import Path

INBOX = Path(os.environ.get("INBOX_DIR", "/opt/.openclaw-ess/inbox/articles"))
DEFAULT_NAME = os.environ.get("DRIVE_XLSX_NAME", "Essential Bali Proofread.xlsx")
TOKEN = "/opt/.openclaw-ess/credentials/google-user-token.json"
SCOPES = ["https://www.googleapis.com/auth/drive"]


def get_drive_service():
    from google.oauth2.credentials import Credentials  # type: ignore
    from google.auth.transport.requests import Request  # type: ignore
    from googleapiclient.discovery import build  # type: ignore

    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        Path(TOKEN).write_text(creds.to_json())
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def search(service, query: str, limit: int = 20):
    """Find xlsx files matching `query` in name."""
    safe = query.replace("'", "\\'")
    q = f"name contains '{safe}' and trashed = false"
    res = service.files().list(
        q=q,
        pageSize=limit,
        fields="files(id, name, mimeType, owners(emailAddress), modifiedTime)",
        orderBy="modifiedTime desc",
    ).execute()
    return res.get("files", [])


def list_xlsx(service, limit: int = 20):
    """List xlsx-like files visible to the OAuth user."""
    q = (
        "(mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'"
        " or mimeType = 'application/vnd.google-apps.spreadsheet')"
        " and trashed = false"
    )
    res = service.files().list(
        q=q,
        pageSize=limit,
        fields="files(id, name, mimeType, owners(emailAddress), modifiedTime)",
        orderBy="modifiedTime desc",
    ).execute()
    return res.get("files", [])


def download(service, file_id: str, mime_type: str, dest: Path):
    """Download a binary file (xlsx) or export a Google Sheet as xlsx."""
    from googleapiclient.http import MediaIoBaseDownload  # type: ignore

    GSHEET = "application/vnd.google-apps.spreadsheet"
    XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    if mime_type == GSHEET:
        request = service.files().export_media(fileId=file_id, mimeType=XLSX)
    else:
        request = service.files().get_media(fileId=file_id)

    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(buf.getvalue())
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--search", default=DEFAULT_NAME, help="name (substring) of xlsx in Drive")
    ap.add_argument("--file-id", help="explicit Drive file ID to fetch")
    ap.add_argument("--list", action="store_true", help="list xlsx files visible to ai@gaiada.com")
    ap.add_argument("--out", help="output path (defaults to inbox/<name>)")
    args = ap.parse_args()

    service = get_drive_service()

    if args.list:
        files = list_xlsx(service)
        if not files:
            print(
                "No xlsx files visible. Either none exist in this account's Drive, "
                "or none are shared with ai@gaiada.com.",
                file=sys.stderr,
            )
            sys.exit(2)
        print(f"{'NAME':<60} {'ID':<35} OWNER")
        for f in files:
            owner = (f.get("owners") or [{}])[0].get("emailAddress", "")
            print(f"{f['name'][:58]:<60} {f['id']:<35} {owner}")
        return

    if args.file_id:
        meta = service.files().get(
            fileId=args.file_id,
            fields="id, name, mimeType",
        ).execute()
        chosen = meta
    else:
        files = search(service, args.search)
        if not files:
            print(
                f"No file matching '{args.search}' visible to ai@gaiada.com.\n"
                f"Either upload it to Drive or share with ai@gaiada.com (Viewer is enough).\n"
                f"Run with --list to see what is currently accessible.",
                file=sys.stderr,
            )
            sys.exit(2)
        # Take most-recent match
        chosen = files[0]
        if len(files) > 1:
            print(
                f"Note: {len(files)} matches; using most recent: '{chosen['name']}' ({chosen['id']})",
                file=sys.stderr,
            )

    dest = Path(args.out) if args.out else INBOX / chosen["name"]
    if not dest.suffix.lower() in (".xlsx", ".xls", ".xlsm"):
        # Forced export → ensure xlsx ext
        dest = dest.with_suffix(".xlsx")

    download(service, chosen["id"], chosen["mimeType"], dest)
    size = dest.stat().st_size
    print(f"✓ wrote {dest} ({size} bytes; {chosen['mimeType']})")


if __name__ == "__main__":
    main()
