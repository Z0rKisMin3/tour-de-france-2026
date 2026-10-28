/*
 * Rendu du document structuré (DOM), export HTML autonome et export Markdown.
 * Le contenu du document est toujours inséré comme texte (jamais interprété en HTML).
 */
const Render = (() => {
  const DOC_CSS = `
.ad-doc { --ink:#1d2330; --muted:#5d6576; --line:#e2e5eb; --soft:#f5f7fb; --accent:#2d5bd7; --accent-soft:#e8eefc; --warn:#9a5b00; --warn-soft:#fff5e5;
  color:var(--ink); background:#fff; font:16px/1.65 Georgia, "Iowan Old Style", "Palatino Linotype", serif; max-width:820px; margin:0 auto; padding:40px 44px; border-radius:10px; }
.ad-doc * { box-sizing:border-box; }
.ad-doc h1, .ad-doc h2, .ad-doc h3, .ad-doc h4, .ad-doc .ad-kicker, .ad-doc .ad-meta, .ad-doc .ad-stats, .ad-doc table, .ad-doc .ad-chip, .ad-doc .ad-ref, .ad-doc .ad-foot, .ad-doc .ad-note
  { font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
.ad-kicker { margin:0 0 6px; color:var(--accent); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.ad-doc h1 { margin:0 0 8px; font-size:30px; line-height:1.2; }
.ad-meta { margin:0 0 22px; color:var(--muted); font-size:13px; }
.ad-stats { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; margin:0 0 30px; }
.ad-stats div { background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
.ad-stats dt { color:var(--muted); font-size:12px; }
.ad-stats dd { margin:2px 0 0; font-size:18px; font-weight:700; }
.ad-doc h2 { font-size:20px; margin:34px 0 12px; padding-bottom:6px; border-bottom:2px solid var(--line); }
.ad-doc h3 { font-size:17px; margin:26px 0 8px; }
.ad-doc h4 { font-size:15px; margin:20px 0 6px; color:var(--muted); }
.ad-doc p { margin:0 0 12px; }
.ad-doc ul, .ad-doc ol { margin:0 0 14px; padding-left:24px; }
.ad-doc li { margin:4px 0; }
.ad-summary { background:var(--accent-soft); border-radius:10px; padding:4px 22px 10px; }
.ad-summary h2 { border-bottom-color:rgba(45,91,215,.25); margin-top:18px; }
.ad-summary li { margin:8px 0; }
.ad-chips { display:flex; flex-wrap:wrap; gap:8px; padding:0; margin:0 0 8px; list-style:none; }
.ad-chip { display:inline-block; padding:4px 10px; border-radius:999px; background:var(--soft); border:1px solid var(--line); font-size:13px; }
.ad-chip b { color:var(--muted); font-weight:500; margin-left:4px; font-size:12px; }
.ad-toc { list-style:none; padding-left:0; }
.ad-toc li { margin:3px 0; }
.ad-toc .l2 { padding-left:20px; } .ad-toc .l3 { padding-left:40px; font-size:15px; }
.ad-doc a { color:var(--accent); text-decoration:none; }
.ad-doc a:hover { text-decoration:underline; }
.ad-actions li { background:var(--warn-soft); border-left:3px solid #e0a030; list-style:none; margin:8px 0 8px -24px; padding:8px 12px; border-radius:0 6px 6px 0; }
.ad-ref { display:block; color:var(--muted); font-size:12px; margin-top:2px; }
.ad-doc table { width:100%; border-collapse:collapse; font-size:13.5px; margin:0 0 18px; }
.ad-doc th, .ad-doc td { text-align:left; vertical-align:top; padding:7px 10px; border-bottom:1px solid var(--line); }
.ad-doc th { background:var(--soft); font-weight:600; }
.ad-doc td.ad-val { white-space:nowrap; font-weight:600; }
.ad-tablewrap { overflow-x:auto; }
.ad-callout { border-left:3px solid var(--accent); background:var(--soft); padding:8px 14px; margin:0 0 14px; font-style:italic; border-radius:0 6px 6px 0; }
.ad-callout::before { content:"En résumé : "; font-style:normal; font-weight:700; color:var(--accent); }
.ad-note { color:var(--muted); font-size:12px; margin:-4px 0 10px; }
.ad-empty { color:var(--muted); font-style:italic; }
.ad-foot { margin-top:40px; padding-top:12px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
@media (max-width:640px) { .ad-doc { padding:24px 18px; } .ad-stats { grid-template-columns:repeat(2, minmax(0,1fr)); } .ad-doc h1 { font-size:24px; } }
@media print { .ad-doc { padding:0; max-width:none; } .ad-doc h2, .ad-doc h3 { break-after:avoid; } .ad-summary, .ad-actions li, .ad-doc tr { break-inside:avoid; } }
`;

  const ENTITY_LABELS = {
    date: 'Dates et échéances',
    amount: 'Montants',
    percent: 'Pourcentages',
    email: 'Adresses e-mail',
    phone: 'Téléphones',
    url: 'Liens',
  };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const fmtNum = (n) => n.toLocaleString('fr-FR');
  const fmtDate = (d) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) +
    ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const sectionTitle = (a, i) => (a.sections[i] && a.sections[i].title) || 'Introduction';

  function sectionRef(a, i) {
    if (a.sections.length < 2) return null;
    return h('span', { class: 'ad-ref' }, '→ ', h('a', { href: '#ad-sec-' + i }, sectionTitle(a, i)));
  }

  function renderBlock(b) {
    if (b.type === 'para') return h('p', null, b.text);
    if (b.type === 'list') {
      // Reconstitue l'imbrication à partir des niveaux
      const root = h(b.ordered ? 'ol' : 'ul');
      const stack = [{ level: 0, el: root }];
      for (const item of b.items) {
        while (stack.length > 1 && item.level < stack[stack.length - 1].level) stack.pop();
        let top = stack[stack.length - 1];
        if (item.level > top.level && top.el.lastElementChild) {
          const sub = h(b.ordered ? 'ol' : 'ul');
          top.el.lastElementChild.append(sub);
          stack.push({ level: item.level, el: sub });
          top = stack[stack.length - 1];
        }
        top.el.append(h('li', null, item.text));
      }
      return root;
    }
    if (b.type === 'table') {
      const [head, ...rows] = b.rows;
      const width = Math.max(...b.rows.map((r) => r.length));
      const pad = (r) => [...r, ...Array(width - r.length).fill('')];
      return h('div', { class: 'ad-tablewrap' }, h('table', null,
        h('thead', null, h('tr', null, pad(head).map((c) => h('th', null, c)))),
        h('tbody', null, rows.map((r) => h('tr', null, pad(r).map((c) => h('td', null, c)))))));
    }
    return null;
  }

  function renderDocument(a, opts = {}) {
    const s = a.stats;
    const metaParts = [];
    if (a.fileName) metaParts.push('Source : ' + a.fileName);
    metaParts.push('Analysé le ' + fmtDate(a.generatedAt));
    metaParts.push(a.lang === 'en' ? 'Langue détectée : anglais' : 'Langue détectée : français');

    const doc = h('article', { class: 'ad-doc', lang: a.lang },
      h('header', null,
        h('p', { class: 'ad-kicker' }, 'Synthèse de document'),
        h('h1', null, a.title),
        h('p', { class: 'ad-meta' }, metaParts.join(' · ')),
        h('dl', { class: 'ad-stats' },
          h('div', null, h('dt', null, 'Mots'), h('dd', null, fmtNum(s.words))),
          h('div', null, h('dt', null, 'Lecture du texte complet'), h('dd', null, '≈ ' + s.readingMinutes + ' min')),
          h('div', null, h('dt', null, 'Sections'), h('dd', null, fmtNum(Math.max(s.sections, 1)))),
          h('div', { title: 'Indice de lisibilité (0 = très difficile, 100 = très facile) — phrases de ' + s.avgSentenceWords + ' mots en moyenne' },
            h('dt', null, 'Lisibilité'), h('dd', null, s.readability.label + ' (' + s.readability.score + ')')))));

    // En bref
    doc.append(h('section', { class: 'ad-summary' },
      h('h2', null, 'En bref'),
      a.summary.length ? h('ul', null, a.summary.map((x) => h('li', null, x.text)))
        : h('p', { class: 'ad-empty' }, 'Texte trop court pour produire une synthèse.')));

    // Mots-clés
    if (a.keywords.length) {
      doc.append(h('section', null, h('h2', null, 'Mots-clés'),
        h('ul', { class: 'ad-chips' }, a.keywords.map((k) => h('li', { class: 'ad-chip' }, k.text, h('b', null, '×' + k.count))))));
    }

    // Sommaire
    const titled = a.sections.map((sec, i) => ({ sec, i })).filter(({ sec }) => sec.title);
    if (titled.length >= 2) {
      doc.append(h('section', null, h('h2', null, 'Sommaire'),
        h('ol', { class: 'ad-toc' }, titled.map(({ sec, i }) =>
          h('li', { class: 'l' + sec.level }, h('a', { href: '#ad-sec-' + i }, sec.title))))));
    }

    // Points d'attention
    if (a.actions.length) {
      doc.append(h('section', null, h('h2', null, "Points d'attention et actions"),
        h('p', { class: 'ad-note' }, 'Phrases contenant une obligation, une demande, un délai ou une action.'),
        h('ul', { class: 'ad-actions' }, a.actions.map((x) => h('li', null, x.text, sectionRef(a, x.section))))));
    }

    // Données repérées
    const kinds = Object.keys(ENTITY_LABELS).filter((k) => a.entities[k] && a.entities[k].length);
    if (kinds.length) {
      const sec = h('section', null, h('h2', null, 'Données repérées'));
      for (const k of kinds) {
        const showSection = a.sections.length > 1;
        sec.append(h('h3', null, ENTITY_LABELS[k] + ' (' + a.entities[k].length + ')'),
          h('div', { class: 'ad-tablewrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Valeur'), h('th', null, 'Contexte'), showSection ? h('th', null, 'Section') : null)),
            h('tbody', null, a.entities[k].map((e) => h('tr', null,
              h('td', { class: 'ad-val' }, e.value, e.count > 1 ? ' (×' + e.count + ')' : ''),
              h('td', null, e.context),
              showSection ? h('td', null, h('a', { href: '#ad-sec-' + e.section }, sectionTitle(a, e.section))) : null))))));
      }
      doc.append(sec);
    }

    // Contenu structuré
    const body = h('section', null, h('h2', null, 'Contenu structuré'));
    a.sections.forEach((sec, i) => {
      const wrap = h('div', { id: 'ad-sec-' + i });
      if (sec.title) wrap.append(h(sec.level === 1 ? 'h3' : 'h4', null, sec.title));
      if (sec.auto) wrap.append(h('p', { class: 'ad-note' }, 'Découpage et titre générés automatiquement.'));
      if (opts.sectionSummaries !== false && a.sectionSummaries[i] && a.sections.length > 1) {
        wrap.append(h('p', { class: 'ad-callout' }, a.sectionSummaries[i]));
      }
      for (const b of sec.blocks) { const el = renderBlock(b); if (el) wrap.append(el); }
      body.append(wrap);
    });
    doc.append(body);

    doc.append(h('footer', { class: 'ad-foot' },
      'Document généré localement par « Analyse de documents » — aucune donnée n\'a été transmise. ' +
      'Synthèse extractive automatique : vérifiez les informations importantes dans le document d\'origine.'));
    return doc;
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toHtmlFile(article, title) {
    return '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">\n' +
      '<title>' + escapeHtml(title) + '</title>\n<style>\nbody{margin:0;background:#eef0f4;padding:24px 12px}\n' + DOC_CSS +
      '\n@media print{body{background:#fff;padding:0}}\n</style>\n</head>\n<body>\n' + article.outerHTML + '\n</body>\n</html>\n';
  }

  function toMarkdown(a, opts = {}) {
    const md = [];
    const esc = (t) => t.replace(/([\\`*_[\]#|])/g, '\\$1');
    const s = a.stats;
    md.push('# ' + esc(a.title), '');
    md.push('_' + [a.fileName ? 'Source : ' + a.fileName : null, 'Analysé le ' + fmtDate(a.generatedAt),
      fmtNum(s.words) + ' mots', '≈ ' + s.readingMinutes + ' min de lecture',
      'Lisibilité : ' + s.readability.label + ' (' + s.readability.score + ')'].filter(Boolean).join(' · ') + '_', '');

    md.push('## En bref', '');
    if (a.summary.length) a.summary.forEach((x) => md.push('- ' + esc(x.text)));
    else md.push('_Texte trop court pour produire une synthèse._');
    md.push('');

    if (a.keywords.length) md.push('## Mots-clés', '', a.keywords.map((k) => '`' + k.text + '` (' + k.count + ')').join(' · '), '');

    const titled = a.sections.filter((x) => x.title);
    if (titled.length >= 2) {
      md.push('## Sommaire', '');
      titled.forEach((sec) => md.push('  '.repeat(sec.level - 1) + '- ' + esc(sec.title)));
      md.push('');
    }

    if (a.actions.length) {
      md.push("## Points d'attention et actions", '');
      a.actions.forEach((x) => md.push('- [ ] ' + esc(x.text) + (a.sections.length > 1 ? ' _(' + esc(sectionTitle(a, x.section)) + ')_' : '')));
      md.push('');
    }

    const kinds = Object.keys(ENTITY_LABELS).filter((k) => a.entities[k] && a.entities[k].length);
    if (kinds.length) {
      md.push('## Données repérées', '');
      for (const k of kinds) {
        md.push('### ' + ENTITY_LABELS[k], '', '| Valeur | Contexte | Section |', '| --- | --- | --- |');
        a.entities[k].forEach((e) => md.push('| ' + esc(e.value) + (e.count > 1 ? ' (×' + e.count + ')' : '') + ' | ' +
          esc(e.context) + ' | ' + esc(sectionTitle(a, e.section)) + ' |'));
        md.push('');
      }
    }

    md.push('## Contenu structuré', '');
    a.sections.forEach((sec, i) => {
      if (sec.title) md.push((sec.level === 1 ? '### ' : '#### ') + esc(sec.title), '');
      if (opts.sectionSummaries !== false && a.sectionSummaries[i] && a.sections.length > 1) md.push('> **En résumé :** ' + esc(a.sectionSummaries[i]), '');
      for (const b of sec.blocks) {
        if (b.type === 'para') md.push(esc(b.text), '');
        else if (b.type === 'list') { b.items.forEach((it) => md.push('  '.repeat(it.level) + (b.ordered ? '1. ' : '- ') + esc(it.text))); md.push(''); }
        else if (b.type === 'table') {
          const width = Math.max(...b.rows.map((r) => r.length));
          const row = (r) => '| ' + [...r, ...Array(width - r.length).fill('')].map(esc).join(' | ') + ' |';
          md.push(row(b.rows[0]), '|' + ' --- |'.repeat(width), ...b.rows.slice(1).map(row), '');
        }
      }
    });
    md.push('---', '_Document généré localement — aucune donnée transmise. Synthèse automatique : à vérifier sur le document d\'origine._', '');
    return md.join('\n');
  }

  return { DOC_CSS, renderDocument, toHtmlFile, toMarkdown };
})();
