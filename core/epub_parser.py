import os
import re
import zipfile
from html import unescape
from typing import List, Dict, Any, Optional

def clean_text_simple(text: str) -> str:
    clean = re.sub(r'<[^>]+>', '', text)
    clean = unescape(clean)
    return re.sub(r'\s+', ' ', clean).strip()

import os
import re
import zipfile
from html import unescape
import xml.etree.ElementTree as ET
from typing import List, Dict, Any, Optional

def clean_text_simple(text: str) -> str:
    clean = re.sub(r'<[^>]+>', '', text)
    clean = unescape(clean)
    return re.sub(r'\s+', ' ', clean).strip()

def parse_ncx_toc(ncx_content: str, base_dir: str):
    """Parses NCX XML and extracts table of contents items."""
    cleaned_xml = re.sub(r'\sxmlns(:\w+)?="[^"]+"', '', ncx_content)
    items = []
    try:
        root = ET.fromstring(cleaned_xml)
        nav_map = root.find('navMap')
        if nav_map is not None:
            def walk_nav_points(parent):
                for np in parent.findall('navPoint'):
                    lbl = np.find('navLabel')
                    txt = lbl.find('text') if lbl is not None else None
                    title = txt.text.strip() if txt is not None and txt.text else ''
                    content_tag = np.find('content')
                    src = content_tag.attrib.get('src', '') if content_tag is not None else ''
                    
                    if title and src:
                        title = clean_text_simple(title)
                        file_part = src.split('#')[0]
                        full_path = os.path.normpath(os.path.join(base_dir, file_part)).replace('\\', '/')
                        anchor = src.split('#')[1] if '#' in src else ''
                        items.append({
                            'title': title,
                            'src': src,
                            'file_path': full_path,
                            'anchor': anchor
                        })
                    walk_nav_points(np)
            walk_nav_points(nav_map)
    except Exception as e:
        pass
    return items

def parse_nav_xhtml_toc(nav_content: str, base_dir: str):
    """Parses EPUB 3 nav.xhtml document."""
    items = []
    cleaned_xml = re.sub(r'\sxmlns(:\w+)?="[^"]+"', '', nav_content)
    try:
        root = ET.fromstring(cleaned_xml)
        for nav in root.iter('nav'):
            epub_type = nav.attrib.get('epub:type', '') or nav.attrib.get('type', '') or nav.attrib.get('id', '')
            if 'toc' in epub_type.lower() or not items:
                for a in nav.iter('a'):
                    title = clean_text_simple(''.join(a.itertext()))
                    href = a.attrib.get('href', '')
                    if title and href:
                        file_part = href.split('#')[0]
                        full_path = os.path.normpath(os.path.join(base_dir, file_part)).replace('\\', '/')
                        anchor = href.split('#')[1] if '#' in href else ''
                        items.append({
                            'title': title,
                            'src': href,
                            'file_path': full_path,
                            'anchor': anchor
                        })
    except Exception as e:
        pass
    return items

def inspect_epub(epub_path: str) -> Dict[str, Any]:
    """Inspects an EPUB file and returns metadata and the exact publisher Table of Contents."""
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

            title_m = re.search(r'<dc:title[^>]*>(.*?)</dc:title>', opf_content, re.IGNORECASE | re.DOTALL)
            author_m = re.search(r'<dc:creator[^>]*>(.*?)</dc:creator>', opf_content, re.IGNORECASE | re.DOTALL)
            
            book_title = clean_text_simple(title_m.group(1)) if title_m else f"Book {book_idx}"
            author = clean_text_simple(author_m.group(1)) if author_m else "Unknown Author"

            base_dir = os.path.dirname(opf_path)

            # 1. Parse manifest items to find NCX / Nav and spine references
            item_pattern = re.compile(r'<item\b([^>]*)/?>', re.IGNORECASE)
            manifest = {}
            ncx_href = None
            nav_href = None

            for m in item_pattern.finditer(opf_content):
                attrs = m.group(1)
                id_m = re.search(r'\bid=[\'"]([^\'"]+)[\'"]', attrs)
                href_m = re.search(r'\bhref=[\'"]([^\'"]+)[\'"]', attrs)
                type_m = re.search(r'\bmedia-type=[\'"]([^\'"]+)[\'"]', attrs)
                props_m = re.search(r'\bproperties=[\'"]([^\'"]+)[\'"]', attrs)

                if id_m and href_m:
                    i_id = id_m.group(1)
                    href = href_m.group(1)
                    m_type = type_m.group(1).lower() if type_m else ''
                    props = props_m.group(1).lower() if props_m else ''
                    full_href = os.path.normpath(os.path.join(base_dir, href)).replace('\\', '/')
                    
                    manifest[i_id] = {
                        'href': full_href,
                        'media_type': m_type
                    }

                    if 'dtbncx' in m_type or i_id.lower() == 'ncx' or href.lower().endswith('.ncx'):
                        ncx_href = full_href
                    if 'nav' in props or i_id.lower() == 'nav' or href.lower().endswith('nav.xhtml'):
                        nav_href = full_href

            # 2. Extract publisher Table of Contents (TOC)
            toc_items = []
            if ncx_href and ncx_href in names:
                try:
                    ncx_raw = z.read(ncx_href).decode('utf-8', errors='ignore')
                    toc_items = parse_ncx_toc(ncx_raw, os.path.dirname(ncx_href))
                except Exception:
                    pass

            if not toc_items and nav_href and nav_href in names:
                try:
                    nav_raw = z.read(nav_href).decode('utf-8', errors='ignore')
                    toc_items = parse_nav_xhtml_toc(nav_raw, os.path.dirname(nav_href))
                except Exception:
                    pass

            if not toc_items:
                # Check for any .ncx file in this book's folder
                for n in names:
                    if n.startswith(base_dir) and n.lower().endswith('.ncx'):
                        try:
                            ncx_raw = z.read(n).decode('utf-8', errors='ignore')
                            toc_items = parse_ncx_toc(ncx_raw, os.path.dirname(n))
                            if toc_items:
                                break
                        except Exception:
                            pass

            chapters = []
            ch_num = 1

            if toc_items:
                seen_files = set()
                for item in toc_items:
                    fpath = item['file_path']
                    if fpath not in names:
                        continue
                    
                    # Deduplicate repeated identical entries without anchors
                    unique_key = (fpath, item.get('anchor', ''))
                    if unique_key in seen_files:
                        continue
                    seen_files.add(unique_key)

                    lower_title = item['title'].lower().strip()
                    # Skip cover and pure table-of-contents link pages
                    if lower_title in ['cover', 'contents', 'table of contents']:
                        continue

                    try:
                        raw_html = z.read(fpath).decode('utf-8', errors='ignore')
                    except Exception:
                        continue

                    text_clean = clean_text_simple(raw_html)
                    word_count = len(text_clean.split())
                    
                    # Skip empty pages or short promo fragments (< 20 words)
                    if word_count < 20:
                        continue

                    duration_mins = round(word_count / 150.0, 1)
                    chapters.append({
                        "chapter_index": ch_num,
                        "title": item['title'],
                        "file_path": fpath,
                        "anchor": item.get('anchor', ''),
                        "word_count": word_count,
                        "estimated_minutes": duration_mins
                    })
                    ch_num += 1
            else:
                # Fallback to spine ordering if EPUB has no TOC
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

                for fpath in ordered_files:
                    if fpath not in names:
                        continue
                    lower_f = fpath.lower()
                    if any(x in lower_f for x in ['cover', 'copyright', 'dedication', 'contents', 'experience']):
                        continue

                    try:
                        raw_html = z.read(fpath).decode('utf-8', errors='ignore')
                    except Exception:
                        continue

                    ch_title, word_count, _ = parse_html_chapter(raw_html, fpath)
                    if word_count < 120 and 'ch' not in lower_f:
                        continue

                    if not ch_title:
                        ch_title = f"Chapter {ch_num}"

                    duration_mins = round(word_count / 150.0, 1)
                    chapters.append({
                        "chapter_index": ch_num,
                        "title": ch_title,
                        "file_path": fpath,
                        "anchor": "",
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

def parse_html_chapter(html: str, fpath: str = "", chapter_title: str = ""):
    """Extracts chapter title, word count, and cleaned paragraphs with chapter heading preserved."""
    tag_re = re.compile(r'<(h[1-6]|p)\b[^>]*>(.*?)</\1>', re.IGNORECASE | re.DOTALL)
    elements = []
    for m in tag_re.finditer(html):
        tag = m.group(1).lower()
        text = clean_text_simple(m.group(2))
        if text:
            elements.append((tag, text))

    body_paras = []
    for tag, text in elements:
        lower_t = text.lower()
        # Skip pure table of contents / link anchors
        if chapter_title and any(k in lower_t for k in ['table of contents', 'contents.xhtml']):
            continue
        # Skip single-line redundant chapter headers if title is already known
        if chapter_title and re.match(r'^(chapter\s+[a-z0-9]+|lesson\s+\d+.*)$', lower_t) and len(lower_t) < 60:
            continue
        body_paras.append(text)

    clean_title = chapter_title.strip() if chapter_title else ""
    if not clean_title:
        # Infer title from first headings or fpath
        m_ch = re.search(r'ch(\d+)', fpath.lower())
        num = int(m_ch.group(1)) if m_ch else 1
        clean_title = f"Chapter {num}"

    header_block = f"— {clean_title.upper()} —"
    story_paras = [header_block] + body_paras if body_paras else [header_block]
    full_cleaned_text = '\n\n'.join(story_paras)
    words = full_cleaned_text.split()
    word_count = len(words)

    return clean_title, word_count, full_cleaned_text

def get_chapter_text(epub_path: str, chapter_file_path: str, chapter_title: str = "") -> Dict[str, Any]:
    """Extracts the full text and metadata for a specific chapter in an EPUB."""
    with zipfile.ZipFile(epub_path, 'r') as z:
        if chapter_file_path not in z.namelist():
            raise FileNotFoundError(f"Chapter file {chapter_file_path} not found in {epub_path}")
        raw_html = z.read(chapter_file_path).decode('utf-8', errors='ignore')

    title, word_count, text = parse_html_chapter(raw_html, chapter_file_path, chapter_title=chapter_title)
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
