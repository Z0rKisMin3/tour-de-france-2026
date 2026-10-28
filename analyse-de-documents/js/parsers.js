/*
 * Lecture des documents → modèle commun de blocs :
 *   { type: 'heading', level, text }
 *   { type: 'para', text }
 *   { type: 'list', ordered, items: [{ text, level }] }
 *   { type: 'table', rows: [[cellule, …], …] }
 * Tout est fait en mémoire, dans le navigateur.
 */
const Parsers = (() => {
  const clean = (s) => s.replace(/[  ]/g, ' ').replace(/[ \t]+/g, ' ').trim();

  /* Accumule les blocs en fusionnant les éléments de liste consécutifs. */
  function blockBuilder() {
    const blocks = [];
    return {
      blocks,
      heading(level, text) {
        text = clean(text);
        if (text) blocks.push({ type: 'heading', level: Math.min(Math.max(level, 1), 6), text });
      },
      para(text) {
        text = clean(text);
        if (text) blocks.push({ type: 'para', text });
      },
      item(text, ordered = false, level = 0) {
        text = clean(text);
        if (!text) return;
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'list') last.items.push({ text, level });
        else blocks.push({ type: 'list', ordered, items: [{ text, level }] });
      },
      table(rows) {
        rows = rows.map((r) => r.map(clean)).filter((r) => r.some(Boolean));
        if (rows.length) blocks.push({ type: 'table', rows });
      },
    };
  }

  /* ---------- Texte brut ---------- */

  const RE_BULLET = /^\s*([-*•▪◦·–—>]|•)\s+(.+)$/;
  const RE_ORDERED = /^\s*(\d{1,3}|[a-z])[.)]\s+(.+)$/i;
  const RE_NUMBERED_HEADING = /^((?:\d{1,3}\.)*\d{1,3}\.?|[IVXLC]{1,6}\.|[A-Z]\.)\s+(\S.*)$/;
  const RE_KEYWORD_HEADING = /^(chapitre|partie|section|article|annexe|titre|chapter|part|appendix)\b\s*[\dIVXLC]*/i;

  function isAllCaps(line) {
    const letters = line.replace(/[^\p{L}]/gu, '');
    return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  }

  /* « COMPTE RENDU DE RÉUNION » → « Compte rendu de réunion » */
  function sentenceCase(line) {
    if (!isAllCaps(line)) return line;
    const lower = line.toLowerCase();
    const i = lower.search(/\p{L}/u);
    return i < 0 ? lower : lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
  }

  function headingLevel(line, prevBlank, nextBlank) {
    const t = line.trim();
    if (t.length > 90 || /[.;,]$/.test(t)) return 0;
    const m = t.match(RE_NUMBERED_HEADING);
    if (m && t.length <= 70 && prevBlank && nextBlank) {
      return Math.min(m[1].replace(/\.$/, '').split('.').length, 4);
    }
    if (RE_KEYWORD_HEADING.test(t) && t.length <= 80 && (prevBlank || nextBlank)) return 1;
    if (isAllCaps(t) && t.length <= 80 && (prevBlank || nextBlank)) return 1;
    if (/:$/.test(t) && t.length <= 60 && prevBlank && !/\s{2,}/.test(t)) return 2;
    return 0;
  }

  function fromPlainText(text) {
    const b = blockBuilder();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let paraBuf = [];
    const flush = () => { if (paraBuf.length) { b.para(paraBuf.join(' ')); paraBuf = []; } };
    const blank = (i) => i < 0 || i >= lines.length || !lines[i].trim();

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { flush(); continue; }

      // Lignes tabulées / séparées par des barres → tableau
      if (/\t|\s\|\s/.test(line) && line.split(/\t|\s\|\s/).length >= 2) {
        const rows = [];
        let j = i;
        while (j < lines.length && lines[j].trim() && /\t|\s\|\s/.test(lines[j])) {
          const cells = lines[j].trim().replace(/^\||\|$/g, '').split(/\t|\s*\|\s*/);
          if (!cells.every((c) => /^[-:\s]*$/.test(c))) rows.push(cells);
          j++;
        }
        if (rows.length >= 2) { flush(); b.table(rows); i = j - 1; continue; }
      }

      const level = paraBuf.length === 0 ? headingLevel(line, blank(i - 1), blank(i + 1)) : 0;
      if (level) { flush(); b.heading(level, sentenceCase(line.replace(/:$/, ''))); continue; }

      const bullet = line.match(RE_BULLET);
      const ordered = !bullet && line.match(RE_ORDERED);
      if (bullet || ordered) {
        flush();
        const indent = Math.min(Math.floor((raw.match(/^\s*/)[0].replace(/\t/g, '    ').length) / 2), 3);
        b.item((bullet || ordered)[2], !!ordered, indent);
        // lignes de continuation (indentées, non vides, pas une nouvelle puce)
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) &&
               !RE_BULLET.test(lines[i + 1]) && !RE_ORDERED.test(lines[i + 1])) {
          const last = b.blocks[b.blocks.length - 1];
          last.items[last.items.length - 1].text += ' ' + clean(lines[++i]);
        }
        continue;
      }
      paraBuf.push(line);
    }
    flush();
    return { blocks: b.blocks };
  }

  /* ---------- Markdown ---------- */

  const stripInlineMd = (s) => s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '');

  function fromMarkdown(text) {
    const b = blockBuilder();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let paraBuf = [];
    let inCode = false;
    const flush = () => { if (paraBuf.length) { b.para(stripInlineMd(paraBuf.join(' '))); paraBuf = []; } };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (/^(```|~~~)/.test(line)) { flush(); inCode = !inCode; continue; }
      if (inCode) { if (line) b.para(line); continue; }
      if (!line) { flush(); continue; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/))) { flush(); b.heading(m[1].length, stripInlineMd(m[2])); continue; }
      if (i + 1 < lines.length && paraBuf.length === 0 && /^(=+|-+)\s*$/.test(lines[i + 1].trim()) && lines[i + 1].trim().length >= 3) {
        flush(); b.heading(lines[i + 1].trim()[0] === '=' ? 1 : 2, stripInlineMd(line)); i++; continue;
      }
      if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line)) { flush(); continue; }
      if (line.startsWith('|')) {
        flush();
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => stripInlineMd(c.trim()));
          if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
          i++;
        }
        i--;
        b.table(rows);
        continue;
      }
      const indent = Math.min(Math.floor(raw.match(/^\s*/)[0].replace(/\t/g, '    ').length / 2), 3);
      if ((m = line.match(/^[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/))) { flush(); b.item(stripInlineMd(m[1]), false, indent); continue; }
      if ((m = line.match(/^\d{1,3}[.)]\s+(.+)$/))) { flush(); b.item(stripInlineMd(m[1]), true, indent); continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { paraBuf.push(m[1]); continue; }
      paraBuf.push(line);
    }
    flush();
    return { blocks: b.blocks };
  }

  /* ---------- HTML ---------- */

  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'FIGURE', 'DL', 'BODY',
    'ADDRESS', 'HR', 'FORM', 'FIELDSET', 'DETAILS', 'CENTER']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT', 'HEAD', 'BUTTON', 'SELECT']);

  function htmlText(el) {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1 && !SKIP_TAGS.has(n.tagName)) {
        if (n.tagName === 'BR') out += ' ';
        else out += htmlText(n);
      }
    }
    return out;
  }

  function walkHtml(el, b, listDepth = 0) {
    let inline = '';
    const flushInline = () => { b.para(inline); inline = ''; };
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { inline += n.nodeValue; continue; }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName)) continue;
      const tag = n.tagName;
      if (!BLOCK_TAGS.has(tag)) {
        if (tag === 'BR') inline += ' ';
        else if (n.querySelector && n.querySelector('p,div,h1,h2,h3,h4,h5,h6,ul,ol,table')) { flushInline(); walkHtml(n, b, listDepth); }
        else inline += htmlText(n);
        continue;
      }
      flushInline();
      if (/^H[1-6]$/.test(tag)) b.heading(+tag[1], htmlText(n));
      else if (tag === 'UL' || tag === 'OL') {
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue;
          const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')));
          b.item(own.map((c) => (c.nodeType === 3 ? c.nodeValue : c.nodeType === 1 ? htmlText(c) : '')).join(' '), tag === 'OL', listDepth);
          for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') walkHtml({ childNodes: [sub] }, b, listDepth + 1);
        }
      } else if (tag === 'TABLE') {
        b.table([...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => htmlText(c))));
      } else if (tag === 'DL') {
        for (const c of n.children) b.item(htmlText(c), false, c.tagName === 'DD' ? 1 : 0);
      } else if (tag === 'P' || tag === 'PRE' || tag === 'ADDRESS') b.para(htmlText(n));
      else if (tag !== 'HR') walkHtml(n, b, listDepth);
    }
    flushInline();
  }

  function fromHtml(text) {
    // DOMParser n'exécute aucun script et ne charge aucune ressource.
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const b = blockBuilder();
    walkHtml(doc.body, b);
    return { title: clean(doc.title || ''), blocks: b.blocks };
  }

  /* ---------- DOCX (Word) ---------- */

  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const wAttr = (el, name) => el && (el.getAttributeNS(W, name) || el.getAttribute('w:' + name));
  const wChild = (el, name) => el && [...el.children].find((c) => c.localName === name);

  function docxRunText(el) {
    let out = '';
    for (const n of el.children) {
      switch (n.localName) {
        case 't': out += n.textContent; break;
        case 'tab': out += '\t'; break;
        case 'br': case 'cr': out += ' '; break;
        case 'noBreakHyphen': out += '-'; break;
        case 'pPr': case 'rPr': case 'instrText': case 'delText': case 'fldChar': break;
        default: if (n.children.length) out += docxRunText(n);
      }
    }
    return out;
  }

  async function fromDocx(buf) {
    const zip = await Zip.open(buf);
    const xml = await zip.text('word/document.xml');
    if (!xml) throw new Error('Fichier .docx invalide (document.xml manquant).');
    const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');

    // Noms des styles (Heading 1, Titre 1, Title…)
    const styleNames = new Map();
    const stylesXml = await zip.text('word/styles.xml');
    if (stylesXml) {
      for (const s of parse(stylesXml).getElementsByTagNameNS(W, 'style')) {
        const name = wAttr(wChild(s, 'name'), 'val');
        styleNames.set(wAttr(s, 'styleId'), (name || '').toLowerCase());
      }
    }

    let title = '';
    const core = await zip.text('docProps/core.xml');
    if (core) {
      const t = parse(core).getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
      if (t) title = clean(t.textContent);
    }

    const doc = parse(xml);
    const body = doc.getElementsByTagNameNS(W, 'body')[0];
    const b = blockBuilder();

    const handleParagraph = (p) => {
      const pPr = wChild(p, 'pPr');
      const styleId = wAttr(wChild(pPr, 'pStyle'), 'val') || '';
      const styleName = styleNames.get(styleId) || styleId.toLowerCase();
      const text = docxRunText(p);
      if (!clean(text)) return;
      let m;
      if (/^(title|titre)$/.test(styleName)) {
        if (!title) title = clean(text);
        else if (clean(text) !== title) b.heading(1, text);
        return;
      }
      if ((m = styleName.match(/^(?:heading|titre|überschrift|titolo|encabezado)\s*(\d)/))) { b.heading(+m[1], text); return; }
      const outline = wAttr(wChild(pPr, 'outlineLvl'), 'val');
      if (outline !== null && outline !== undefined && outline !== '' && +outline < 9) { b.heading(+outline + 1, text); return; }
      const numPr = wChild(pPr, 'numPr');
      if (numPr || /list|liste/.test(styleName)) {
        const lvl = +(wAttr(wChild(numPr, 'ilvl'), 'val') || 0);
        b.item(text, false, Math.min(lvl, 3));
        return;
      }
      b.para(text);
    };

    const walk = (container) => {
      for (const el of container.children) {
        if (el.localName === 'p') handleParagraph(el);
        else if (el.localName === 'tbl') {
          const rows = [...el.children].filter((r) => r.localName === 'tr').map((tr) =>
            [...tr.children].filter((c) => c.localName === 'tc').map((tc) =>
              [...tc.children].filter((x) => x.localName === 'p').map(docxRunText).join(' ')));
          b.table(rows);
        } else if (el.localName === 'sdt') {
          const content = wChild(el, 'sdtContent');
          if (content) walk(content);
        }
      }
    };
    walk(body);
    return { title, blocks: b.blocks };
  }

  /* ---------- ODT (LibreOffice / OpenOffice) ---------- */

  const NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  const NS_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
  const NS_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

  function odtText(el) {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.namespaceURI === NS_TEXT && n.localName === 's') out += ' '.repeat(+(n.getAttributeNS(NS_TEXT, 'c') || 1));
        else if (n.namespaceURI === NS_TEXT && (n.localName === 'tab' || n.localName === 'line-break')) out += ' ';
        else if (n.namespaceURI === NS_TEXT && (n.localName === 'note' || n.localName === 'tracked-changes')) continue;
        else out += odtText(n);
      }
    }
    return out;
  }

  async function fromOdt(buf) {
    const zip = await Zip.open(buf);
    const xml = await zip.text('content.xml');
    if (!xml) throw new Error('Fichier .odt invalide (content.xml manquant).');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const officeText = doc.getElementsByTagNameNS(NS_OFFICE, 'text')[0];
    const b = blockBuilder();

    const walk = (el, depth) => {
      for (const n of el.children) {
        const ln = n.localName;
        if (n.namespaceURI === NS_TEXT && ln === 'h') b.heading(+(n.getAttributeNS(NS_TEXT, 'outline-level') || 1), odtText(n));
        else if (n.namespaceURI === NS_TEXT && ln === 'p') b.para(odtText(n));
        else if (n.namespaceURI === NS_TEXT && ln === 'list') {
          for (const li of n.children) {
            for (const c of li.children) {
              if (c.localName === 'list') walk({ children: [c] }, depth + 1);
              else if (c.localName === 'p' || c.localName === 'h') b.item(odtText(c), false, Math.min(depth, 3));
            }
          }
        } else if (n.namespaceURI === NS_TABLE && ln === 'table') {
          const rows = [...n.getElementsByTagNameNS(NS_TABLE, 'table-row')].map((tr) =>
            [...tr.children].filter((c) => c.localName === 'table-cell').map(odtText));
          b.table(rows);
        } else if (n.children && n.children.length) walk(n, depth);
      }
    };
    if (officeText) walk(officeText, 0);
    return { blocks: b.blocks };
  }

  /* ---------- Point d'entrée ---------- */

  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { return new TextDecoder('windows-1252').decode(buf); }
  }

  function looksLikeMarkdown(text) {
    return /^#{1,6}\s+\S/m.test(text) || /^\|.+\|\s*$/m.test(text) && /^\|?\s*:?-{3,}/m.test(text);
  }

  async function parseFile(file) {
    const name = file.name || 'document';
    const ext = (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    const buf = await file.arrayBuffer();
    let result;
    if (ext === 'docx' || ext === 'docm') result = await fromDocx(buf);
    else if (ext === 'odt') result = await fromOdt(buf);
    else if (ext === 'pdf') throw new Error("Les PDF ne sont pas encore pris en charge : ouvrez-le, copiez le texte et collez-le dans la zone de texte.");
    else if (ext === 'doc') throw new Error("L'ancien format Word .doc n'est pas pris en charge : enregistrez-le en .docx depuis Word.");
    else {
      const text = decodeText(buf);
      if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype html|html)/i.test(text)) result = fromHtml(text);
      else if (ext === 'md' || ext === 'markdown' || looksLikeMarkdown(text)) result = fromMarkdown(text);
      else result = fromPlainText(text);
    }
    return { title: result.title || '', fileName: name, blocks: result.blocks };
  }

  function parseText(text) {
    const result = /^\s*<(!doctype html|html|body|p|div|h1)/i.test(text) ? fromHtml(text)
      : looksLikeMarkdown(text) ? fromMarkdown(text) : fromPlainText(text);
    return { title: result.title || '', fileName: '', blocks: result.blocks };
  }

  return { parseFile, parseText, fromPlainText, fromMarkdown, fromHtml };
})();
