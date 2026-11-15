import os
import re
import zipfile
from html import unescape
from typing import List, Dict, Any, Optional

def clean_text_simple(text: str) -> str:
    clean = re.sub(r'<[^>]+>', '', text)
    clean = unescape(clean)
    return re.sub(r'\s+', ' ', clean).strip()

def inspect_epub(epub_path: str) -> Dict[str, Any]:
    """Inspects an EPUB file and returns metadata and a clean list of chapters."""
    if not os.path.exists(epub_path):
        raise FileNotFoundError(f"EPUB file not found: {epub_path}")

    books = []
    with zipfile.ZipFile(epub_path, 'r') as z:
        names = z.namelist()
        opf_files = [n for n in names if n.lower().endswith('.opf')]
        opf_files.sort()

        if len(opf_files) > 1 and 'content.opf' in opf_files:
            sub_opfs = [o for o in opf_files if o != 'content.opf']
            if sub_opfs:
                opf_files = sub_opfs

        book_idx = 1
        for opf_path in opf_files:
            try:
                opf_content = z.read(opf_path).decode('utf-8', errors='ignore')
            except Exception:
                continue

            # Extract title & creator
            title_m = re.search(r'<dc:title[^>]*>(.*?)</dc:title>', opf_content, re.IGNORECASE | re.DOTALL)
            author_m = re.search(r'<dc:creator[^>]*>(.*?)</dc:creator>', opf_content, re.IGNORECASE | re.DOTALL)
            
            book_title = clean_text_simple(title_m.group(1)) if title_m else f"Book {book_idx}"
            author = clean_text_simple(author_m.group(1)) if author_m else "Unknown Author"

            base_dir = os.path.dirname(opf_path)

            # Parse manifest items
            item_pattern = re.compile(r'<item\b([^>]*)/?>', re.IGNORECASE)
            manifest = {}
            for m in item_pattern.finditer(opf_content):
                attrs = m.group(1)
                id_m = re.search(r'\bid=[\'"]([^\'"]+)[\'"]', attrs)
                href_m = re.search(r'\bhref=[\'"]([^\'"]+)[\'"]', attrs)
                type_m = re.search(r'\bmedia-type=[\'"]([^\'"]+)[\'"]', attrs)
                if id_m and href_m:
                    i_id = id_m.group(1)
                    href = href_m.group(1)
                    m_type = type_m.group(1) if type_m else ''
                    full_href = os.path.normpath(os.path.join(base_dir, href)).replace('\\', '/')
                    manifest[i_id] = {
                        'href': full_href,
                        'media_type': m_type
                    }

            # Parse spine order
            spine_pattern = re.compile(r'<itemref\b([^>]*)/?>', re.IGNORECASE)
            spine_ids = []
            for m in spine_pattern.finditer(opf_content):
                attrs = m.group(1)
                idref_m = re.search(r'\bidref=[\'"]([^\'"]+)[\'"]', attrs)
                if idref_m:
                    spine_ids.append(idref_m.group(1))

            ordered_files = []
            if spine_ids:
                for sid in spine_ids:
                    if sid in manifest:
                        ordered_files.append(manifest[sid]['href'])
            else:
                ordered_files = [m['href'] for m in manifest.values() if 'html' in m['media_type'] or m['href'].endswith('.html')]

            chapters = []
            ch_num = 1
            for fpath in ordered_files:
                if fpath not in names:
                    continue
                lower_f = fpath.lower()
                # Skip non-reading content
                if any(x in lower_f for x in ['cover', 'copyright', 'dedication', 'contents', 'experience']):
                    continue

                try:
                    raw_html = z.read(fpath).decode('utf-8', errors='ignore')
                except Exception:
                    continue

                ch_title, word_count, clean_text = parse_html_chapter(raw_html, fpath)
                if word_count < 120 and 'ch' not in lower_f:
                    # Skip intro / title page
                    continue

                if not ch_title:
                    ch_title = f"Chapter {ch_num}"

                duration_mins = round(word_count / 150.0, 1)

                chapters.append({
                    "chapter_index": ch_num,
                    "title": ch_title,
                    "file_path": fpath,
                    "word_count": word_count,
                    "estimated_minutes": duration_mins
                })
                ch_num += 1

            if chapters:
                books.append({
                    "book_index": book_idx,
                    "title": book_title,
                    "author": author,
                    "chapters_count": len(chapters),
                    "total_words": sum(c['word_count'] for c in chapters),
                    "chapters": chapters
                })
                book_idx += 1

    return {
        "file_name": os.path.basename(epub_path),
        "total_books": len(books),
        "books": books
    }

def parse_html_chapter(html: str, fpath: str = ""):
    """Extracts chapter title, word count, and cleaned paragraphs."""
    # Find h1 / h2 / h3 or title tags
    title_candidates = []
    for t_tag in ['h1', 'h2', 'h3']:
        for m in re.finditer(rf'<{t_tag}[^>]*>(.*?)</{t_tag}>', html, re.IGNORECASE | re.DOTALL):
            c = clean_text_simple(m.group(1))
            if c:
                title_candidates.append(c)

    # Paragraph elements
    raw_paras = re.findall(r'<p\b[^>]*>(.*?)</p>', html, re.IGNORECASE | re.DOTALL)
    clean_paras = []
    for p in raw_paras:
        c = clean_text_simple(p)
        if c:
            clean_paras.append(c)

    # Infer title: look for "CHAPTER ONE / The Boy Who Lived" pattern
    title = ""
    start_para_idx = 0
    if clean_paras:
        # Check first 3 paragraphs for chapter heading pattern
        p0 = clean_paras[0] if len(clean_paras) > 0 else ""
        p1 = clean_paras[1] if len(clean_paras) > 1 else ""
        p2 = clean_paras[2] if len(clean_paras) > 2 else ""

        if "chapter" in p0.lower() and len(p0) < 60:
            if p1 and len(p1) < 60 and not p1.endswith('.'):
                title = f"{p0} - {p1}"
                start_para_idx = 2
            else:
                title = p0
                start_para_idx = 1
        elif "chapter" in p1.lower() and len(p1) < 60:
            if p2 and len(p2) < 60 and not p2.endswith('.'):
                title = f"{p1} - {p2}"
                start_para_idx = 3
            else:
                title = f"{p0} - {p1}"
                start_para_idx = 2
        elif title_candidates:
            title = " - ".join(title_candidates[:2])

    if not title:
        m_ch = re.search(r'ch(\d+)', fpath.lower())
        if m_ch:
            title = f"Chapter {int(m_ch.group(1))}"
        elif title_candidates:
            title = title_candidates[0]

    story_paras = clean_paras[start_para_idx:] if start_para_idx < len(clean_paras) else clean_paras
    full_cleaned_text = '\n\n'.join(story_paras)
    words = full_cleaned_text.split()
    word_count = len(words)

    return title, word_count, full_cleaned_text

def get_chapter_text(epub_path: str, chapter_file_path: str) -> Dict[str, Any]:
    """Extracts the full text and metadata for a specific chapter in an EPUB."""
    with zipfile.ZipFile(epub_path, 'r') as z:
        if chapter_file_path not in z.namelist():
            raise FileNotFoundError(f"Chapter file {chapter_file_path} not found in {epub_path}")
        raw_html = z.read(chapter_file_path).decode('utf-8', errors='ignore')

    title, word_count, text = parse_html_chapter(raw_html, chapter_file_path)
    return {
        "title": title,
        "word_count": word_count,
        "estimated_minutes": round(word_count / 150.0, 1),
        "text": text
    }

if __name__ == '__main__':
    p = r'C:/Users/ADMIN/.gemini/antigravity/brain/a09130ad-a1c2-4b85-9453-ef1c7e7e21dd/.user_uploaded/media_1794742886715_a8bad644.epub'
    res = inspect_epub(p)
    print("Inspecting Book 1 chapters:")
    b1 = res['books'][0]
    print(f"Book: {b1['title']} ({len(b1['chapters'])} chapters)")
    for c in b1['chapters'][:7]:
        print(f"  {c['chapter_index']}. {c['title']} | {c['word_count']} words (~{c['estimated_minutes']} min)")
