#!/usr/bin/env python3
"""
EPUB to Audiobook Project Converter for Kokoro & Fish Speech Studio
Usage:
    python convert_epub.py --epub "path/to/book.epub" --list
    python convert_epub.py --epub "path/to/book.epub" --book 1 --chapter 1 --studio kokoro
    python convert_epub.py --epub "path/to/book.epub" --book 1 --chapter 1 --studio fish
    python convert_epub.py --epub "path/to/book.epub" --book 1 --chapter 1 --out "Chapter_1.txt"
"""

import os
import sys
import argparse
import json
import urllib.request
from core.epub_parser import inspect_epub, get_chapter_text

DEFAULT_EPUB = r"C:/Users/ADMIN/.gemini/antigravity/brain/a09130ad-a1c2-4b85-9453-ef1c7e7e21dd/.user_uploaded/media_1794742886715_a8bad644.epub"
DEFAULT_STUDIO_URL = "http://localhost:7865"

def list_books_and_chapters(epub_path: str):
    info = inspect_epub(epub_path)
    print(f"\n==================================================================")
    print(f"📖 EPUB: {info['file_name']}")
    print(f"📚 Total Volumes / Books: {info['total_books']}")
    print(f"==================================================================")

    for b in info['books']:
        print(f"\n[Book {b['book_index']}] {b['title']} by {b['author']}")
        print(f"   Chapters: {b['chapters_count']} | Total Words: {b['total_words']:,} (~{round(b['total_words']/150/60, 1)} hrs)")
        print(f"   --------------------------------------------------------------")
        for c in b['chapters']:
            print(f"   Ch {c['chapter_index']:2d}: {c['title']:<45} | {c['word_count']:5,d} words (~{c['estimated_minutes']:4.1f} min)")

def create_studio_project(title: str, text: str, engine: str = "kokoro", voice: str = "") -> dict:
    url = f"{DEFAULT_STUDIO_URL}/api/projects/new"
    default_voice = voice or ("bf_emma" if engine == "kokoro" else "voice_stanley_narrator")
    payload = {
        "title": title,
        "engine": engine,
        "default_voice": default_voice,
        "text": text
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))

def main():
    parser = argparse.ArgumentParser(description="Convert EPUB Chapters to Audiobook Projects")
    parser.add_argument("--epub", default=DEFAULT_EPUB, help="Path to .epub file")
    parser.add_argument("--list", action="store_true", help="List all books and chapters with duration")
    parser.add_argument("--book", type=int, default=1, help="Book index (1-based, default 1)")
    parser.add_argument("--chapter", type=int, default=1, help="Chapter index (1-based, default 1)")
    parser.add_argument("--studio", choices=["kokoro", "fish"], default="kokoro", help="Target studio (kokoro or fish)")
    parser.add_argument("--voice", default="", help="Default narrator voice id")
    parser.add_argument("--out", default="", help="Export to a local .txt file instead of studio project")

    args = parser.parse_args()

    if not os.path.exists(args.epub):
        print(f"❌ Error: EPUB file not found: {args.epub}")
        sys.exit(1)

    if args.list:
        list_books_and_chapters(args.epub)
        return

    info = inspect_epub(args.epub)
    if args.book < 1 or args.book > len(info['books']):
        print(f"❌ Error: Book index {args.book} out of range (1-{len(info['books'])})")
        sys.exit(1)

    book = info['books'][args.book - 1]
    if args.chapter < 1 or args.chapter > len(book['chapters']):
        print(f"❌ Error: Chapter index {args.chapter} out of range (1-{len(book['chapters'])})")
        sys.exit(1)

    ch_meta = book['chapters'][args.chapter - 1]
    ch_data = get_chapter_text(args.epub, ch_meta['file_path'])

    full_title = f"{book['title']} - Ch {args.chapter}: {ch_meta['title']}"

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(f"{full_title}\n\n{ch_data['text']}")
        print(f"✓ Saved chapter to: {args.out} ({ch_data['word_count']} words)")
        return

    print(f"\n⏳ Creating Audiobook Project in {args.studio.upper()} Studio...")
    print(f"   Title: {full_title}")
    print(f"   Words: {ch_data['word_count']:,} (~{ch_data['estimated_minutes']} mins of audio)")

    proj = create_studio_project(full_title, ch_data['text'], engine=args.studio, voice=args.voice)
    proj_id = proj.get("id")

    if args.studio == "kokoro":
        studio_url = f"{DEFAULT_STUDIO_URL}/kokoro/studio?project={proj_id}"
    else:
        studio_url = f"{DEFAULT_STUDIO_URL}/studio?project={proj_id}"

    print(f"\n🎉 Project successfully created!")
    print(f"   Project ID: {proj_id}")
    print(f"   Sentences: {len(proj.get('blocks', []))} blocks")
    print(f"   👉 Open in Studio: {studio_url}\n")

if __name__ == '__main__':
    main()
