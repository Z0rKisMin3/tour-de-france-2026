/*
 * Analyse du modèle de blocs : structure en sections, synthèse extractive,
 * mots-clés, données repérées (dates, montants, contacts…), points d'attention,
 * statistiques et lisibilité. Aucun appel externe.
 */
const Analyzer = (() => {
  const STOP_FR = `a à afin ai aie aient aies ait alors après as au aucun aucune aupres auprès aussi autre autres aux avaient avais avait avant avec avez aviez avions avoir avons ayant ayez ayons bien c ça car ce ceci cela celle celles celui cependant certains ces cet cette ceux chacun chaque chez ci comme comment d dans de des depuis donc dont du durant elle elles en encore entre es est et étaient étais était étant été êtes être eu eue eues eurent eus eut eux fait faire fois font furent fut il ils j je jusqu l la le les leur leurs lors lui m ma mais me même mêmes mes moi moins mon n ne ni nos notre nous on ont ou où par parce pas pendant peu peut peuvent plus plusieurs pour pourquoi pourra pourrait près puis qu quand que quel quelle quelles quels qui quoi s sa sans se selon sera serait seront ses si sien sienne soi soient sois soit sommes son sont sous suis sur t ta tandis te tel telle telles tels tes toi ton tous tout toute toutes très tu un une unes uns vers via vos votre vous y ainsi déjà dès doit doivent devra devront être celle-ci celui-ci ceux-ci là non oui afin cas lequel laquelle lesquels lesquelles auquel auxquels duquel desquels etc ici tant toujours jamais souvent également notamment chez avoir faut faudra sera seraient`;
  const STOP_EN = `a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also may must shall within without upon however therefore thus per via`;
  const STOP = new Set((STOP_FR + ' ' + STOP_EN).split(/\s+/));
  const FR_HINTS = new Set(STOP_FR.split(/\s+/).filter((w) => w.length > 2));
  const EN_HINTS = new Set(STOP_EN.split(/\s+/).filter((w) => w.length > 2));

  const ABBR = new Set(['m', 'mm', 'mme', 'mmes', 'mlle', 'dr', 'pr', 'me', 'st', 'ste', 'art', 'al', 'cf', 'etc', 'ex',
    'p', 'pp', 'n', 'no', 'vol', 'chap', 'fig', 'env', 'min', 'max', 'approx', 'vs', 'mr', 'mrs', 'ms', 'inc', 'ltd',
    'jr', 'sr', 'av', 'bd', 'tel', 'tél', 'réf', 'ref', 'hab', 'qté', 'mo', 'ko', 'go', 'e.g', 'i.e', 'c.-à-d', 'sté']);

  const MONTHS_FR = 'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre';
  const MONTHS_EN = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const NUM = String.raw`\d{1,3}(?:[   .,']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;

  const ENTITY_PATTERNS = {
    date: [
      new RegExp(String.raw`\b(?:1er|[0-3]?\d)\s+(?:${MONTHS_FR})(?:\s+\d{4})?\b`, 'giu'),
      new RegExp(String.raw`\b(?:${MONTHS_FR})\s+\d{4}\b`, 'giu'),
      new RegExp(String.raw`\b(?:${MONTHS_EN})\s+[0-3]?\d(?:st|nd|rd|th)?,?\s+\d{4}\b`, 'gi'),
      new RegExp(String.raw`\b[0-3]?\d\s+(?:${MONTHS_EN})\s+\d{4}\b`, 'gi'),
      /\b[0-3]?\d[\/.][01]?\d[\/.](?:19|20)?\d{2}\b/g,
      /\b(?:19|20)\d{2}-[01]\d-[0-3]\d\b/g,
    ],
    amount: [
      new RegExp(String.raw`(?:[€$£]\s?(?:${NUM})(?:\s?(?:k|K|M|Md|millions?|milliards?))?)`, 'gu'),
      new RegExp(String.raw`(?:${NUM})\s?(?:k€|K€|M€|Md€|€|EUR|euros?|USD|\$|dollars?|£|GBP|CHF|francs?)(?![\p{L}])`, 'gu'),
      new RegExp(String.raw`(?:${NUM})\s(?:millions?|milliards?)\s(?:d['’]\s?)?(?:euros?|dollars?)`, 'giu'),
    ],
    percent: [new RegExp(String.raw`(?:${NUM})\s?(?:%|pour\s?cent|percent)`, 'giu')],
    email: [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
    phone: [/(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g, /\+\d{1,3}(?:[\s.-]?\d{1,4}){2,5}\b/g],
    url: [/\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi],
  };

  const ACTION_RE = /\b(doit|doivent|devra|devront|devrait|il faut|il faudra|il convient|il est (?:nécessaire|impératif|demandé|recommandé)|obligatoire(?:ment)?|impérativement|est tenue?s? de|sont tenue?s? de|s['’]engage|à faire|à prévoir|à valider|à transmettre|à fournir|à compléter|action|échéance|date limite|délai|au plus tard|avant le|interdit|prière de|merci de|veuillez|must|shall|should|required|deadline|due|need to|needs to|to do|action item)\b/i;

  /* ---------- Utilitaires texte ---------- */

  function splitSentences(text) {
    const parts = text.split(/(?<=[.!?…])\s+(?=[«"“'(\[\p{Lu}\d])/u);
    const out = [];
    for (const p of parts) {
      if (out.length) {
        const prev = out[out.length - 1];
        const m = prev.match(/(?:^|[\s(])([\p{L}.\-]+)\.$/u);
        if (m && (ABBR.has(m[1].toLowerCase()) || /^\p{Lu}$/u.test(m[1]))) { out[out.length - 1] = prev + ' ' + p; continue; }
      }
      out.push(p);
    }
    return out.map((s) => s.trim()).filter(Boolean);
  }

  function words(text) {
    return (text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]*/gu) || [])
      .map((w) => w.replace(/^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu|quoiqu)['’]/, '').replace(/['’-]+$/, ''))
      .filter(Boolean);
  }

  const stem = (w) => (w.length > 4 && /[sx]$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
  const isContent = (w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w);

  function countSyllables(word, lang) {
    const groups = word.toLowerCase().match(/[aeiouyàâäéèêëîïôöûüùœæ]+/g);
    let n = groups ? groups.length : 1;
    if (lang === 'fr' && n > 1 && /[^aeiouy]es?$|[^aeiouy]ent$/.test(word) && /e(s|nt)?$/.test(word)) n--;
    if (lang === 'en' && n > 1 && /[^aeiouy]e$/.test(word)) n--;
    return Math.max(n, 1);
  }

  function readabilityLabel(score) {
    if (score >= 80) return 'Très facile';
    if (score >= 70) return 'Facile';
    if (score >= 60) return 'Standard';
    if (score >= 50) return 'Assez difficile';
    if (score >= 30) return 'Difficile';
    return 'Très difficile';
  }

  /* ---------- Structure ---------- */

  function buildSections(parsed) {
    let blocks = parsed.blocks.slice();
    let title = parsed.title;

    // Un titre de niveau minimal unique en tête du document = titre du document.
    const headings = blocks.filter((b) => b.type === 'heading');
    if (headings.length) {
      const minLevel = Math.min(...headings.map((h) => h.level));
      const top = headings.filter((h) => h.level === minLevel);
      if (top.length === 1 && blocks[0] === top[0] && headings.length > 1) {
        if (!title) title = top[0].text;
        blocks = blocks.slice(1);
      } else if (!title && blocks[0] && blocks[0].type === 'heading' && headings.length === 1) {
        title = blocks[0].text;
        blocks = blocks.slice(1);
      }
    }

    // Niveaux réels → 1, 2, 3 (rendu h2, h3, h4)
    const levels = [...new Set(blocks.filter((b) => b.type === 'heading').map((b) => b.level))].sort((a, b) => a - b);
    const levelMap = new Map(levels.map((l, i) => [l, Math.min(i + 1, 3)]));

    const sections = [];
    let current = { title: '', level: 1, blocks: [], auto: false };
    for (const b of blocks) {
      if (b.type === 'heading') {
        if (current.blocks.length || current.title) sections.push(current);
        current = { title: b.text, level: levelMap.get(b.level), blocks: [], auto: false };
      } else current.blocks.push(b);
    }
    if (current.blocks.length || current.title) sections.push(current);
    if (sections.length && !sections[0].title) sections[0].title = sections.length > 1 ? 'Préambule' : '';
    return { title, sections };
  }

  /* Sans titres : découpe en parties de quelques paragraphes, titrées par leurs mots dominants. */
  function autoSection(sections, stemFreq, forms) {
    if (sections.length !== 1 || sections[0].title) return sections;
    const blocks = sections[0].blocks;
    if (blocks.length < 7) return sections;
    const size = Math.max(3, Math.round(blocks.length / Math.ceil(blocks.length / 5)));
    const out = [];
    for (let i = 0; i < blocks.length; i += size) {
      const chunk = blocks.slice(i, i + size);
      const local = new Map();
      for (const t of words(chunk.map(blockText).join(' '))) {
        if (!isContent(t)) continue;
        const s = stem(t);
        local.set(s, (local.get(s) || 0) + 1);
      }
      const top = [...local.entries()]
        .sort((a, b) => b[1] * Math.log(1 + (stemFreq.get(b[0]) || 1)) - a[1] * Math.log(1 + (stemFreq.get(a[0]) || 1)))
        .slice(0, 3).map(([s]) => bestForm(forms, s));
      out.push({ title: `Partie ${out.length + 1}` + (top.length ? ' — ' + top.join(', ') : ''), level: 1, blocks: chunk, auto: true });
    }
    return out;
  }

  function blockText(b) {
    if (b.type === 'para') return b.text;
    if (b.type === 'list') return b.items.map((i) => i.text).join('. ');
    if (b.type === 'table') return b.rows.map((r) => r.join(' ; ')).join('. ');
    return b.text || '';
  }

  function bestForm(forms, s) {
    const m = forms.get(s);
    if (!m) return s;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  /* ---------- Analyse principale ---------- */

  function analyze(parsed, options = {}) {
    const { title, sections: rawSections } = buildSections(parsed);

    // Phrases (paragraphes + éléments de liste), rattachées à leur section
    const collectSentences = (sections) => {
      const list = [];
      sections.forEach((sec, si) => {
        let firstInSection = true;
        for (const b of sec.blocks) {
          const texts = b.type === 'para' ? [b.text] : b.type === 'list' ? b.items.map((i) => i.text) : [];
          for (const t of texts) {
            for (const s of splitSentences(t)) {
              list.push({ text: s, section: si, first: firstInSection, idx: list.length });
              firstInSection = false;
            }
          }
        }
      });
      return list;
    };

    // Fréquences
    const stemFreq = new Map();
    const forms = new Map();
    const bigrams = new Map();
    const allText = rawSections.flatMap((s) => [s.title, ...s.blocks.map(blockText)]).join('\n');
    let wordCount = 0, syllables = 0, frHits = 0, enHits = 0;
    for (const clause of allText.split(/[\n,;:()«»"“”.!?…\[\]]+/)) {
      const toks = words(clause);
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        wordCount++;
        if (FR_HINTS.has(t)) frHits++;
        if (EN_HINTS.has(t)) enHits++;
        if (!isContent(t)) continue;
        const s = stem(t);
        stemFreq.set(s, (stemFreq.get(s) || 0) + 1);
        if (!forms.has(s)) forms.set(s, new Map());
        forms.get(s).set(t, (forms.get(s).get(t) || 0) + 1);
        const n = toks[i + 1];
        if (n && isContent(n)) {
          const key = s + ' ' + stem(n);
          const e = bigrams.get(key) || { count: 0, forms: new Map() };
          e.count++;
          const f = t + ' ' + n;
          e.forms.set(f, (e.forms.get(f) || 0) + 1);
          bigrams.set(key, e);
        }
      }
    }
    const lang = enHits > frHits * 1.3 ? 'en' : 'fr';

    const sections = autoSection(rawSections, stemFreq, forms);
    const sentences = collectSentences(sections);
    for (const s of sentences) {
      for (const w of words(s.text)) syllables += countSyllables(w, lang);
    }

    // Mots-clés : expressions récurrentes puis mots fréquents
    const phraseList = [...bigrams.entries()]
      .filter(([, e]) => e.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([key, e]) => ({ text: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0], count: e.count, stems: key.split(' ') }));
    const coveredStems = new Set(phraseList.flatMap((p) => p.stems));
    const wordList = [...stemFreq.entries()]
      .filter(([s, c]) => c >= 2 && !(coveredStems.has(s) && phraseList.some((p) => p.stems.includes(s) && p.count >= c * 0.6)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12 - Math.min(phraseList.length, 4))
      .map(([s, c]) => ({ text: bestForm(forms, s), count: c }));
    const keywords = [...phraseList.slice(0, 4), ...wordList].sort((a, b) => b.count - a.count);

    // Score des phrases
    const maxFreq = Math.max(1, ...stemFreq.values());
    const scored = sentences.map((s) => {
      const toks = words(s.text);
      const content = [...new Set(toks.filter(isContent).map(stem))];
      let score = content.reduce((acc, st) => acc + (stemFreq.get(st) || 0) / maxFreq, 0) / Math.pow(content.length + 1, 0.6);
      if (s.first) score *= 1.15;
      if (s.idx === 0) score *= 1.2;
      if (toks.length < 6) score *= 0.3;
      else if (toks.length > 50) score *= 0.7;
      if (/\?$/.test(s.text)) score *= 0.6;
      return { ...s, score, stems: new Set(content), wordCount: toks.length };
    });

    const pick = (pool, k) => {
      const chosen = [];
      for (const s of [...pool].sort((a, b) => b.score - a.score)) {
        if (chosen.length >= k) break;
        const redundant = chosen.some((c) => {
          const inter = [...s.stems].filter((x) => c.stems.has(x)).length;
          return inter / (s.stems.size + c.stems.size - inter || 1) > 0.5;
        });
        if (!redundant && s.wordCount >= 4) chosen.push(s);
      }
      return chosen.sort((a, b) => a.idx - b.idx);
    };

    const sizes = { short: [0.05, 3, 5], medium: [0.1, 4, 8], long: [0.2, 6, 15] };
    const [ratio, min, max] = sizes[options.summaryLength] || sizes.medium;
    const k = Math.min(max, Math.max(min, Math.round(scored.length * ratio)));
    const summary = pick(scored, k).map((s) => ({ text: s.text, section: s.section }));

    // Résumé par section (si la section est assez longue)
    const sectionSummaries = sections.map((sec, si) => {
      const pool = scored.filter((s) => s.section === si);
      if (pool.length < 5) return null;
      const best = pick(pool, 1)[0];
      return best ? best.text : null;
    });

    // Points d'attention / actions
    const seen = new Set();
    const actions = scored
      .filter((s) => ACTION_RE.test(s.text) && s.wordCount >= 4 && s.wordCount <= 70)
      .filter((s) => { const key = s.text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, 20)
      .map((s) => ({ text: s.text, section: s.section }));

    // Données repérées
    const entities = { date: new Map(), amount: new Map(), percent: new Map(), email: new Map(), phone: new Map(), url: new Map() };
    sections.forEach((sec, si) => {
      const texts = sec.blocks.flatMap((b) =>
        b.type === 'para' ? [b.text] : b.type === 'list' ? b.items.map((i) => i.text) : b.type === 'table' ? b.rows.map((r) => r.join(' · ')) : []);
      for (const t of texts) {
        const sents = splitSentences(t);
        for (const [kind, patterns] of Object.entries(ENTITY_PATTERNS)) {
          const found = [];
          for (const re of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(t))) {
              const start = m.index, end = start + m[0].length;
              if (found.some((f) => start < f.end && end > f.start)) continue;
              found.push({ start, end, value: m[0].trim().replace(/[.,;:]$/, '') });
            }
          }
          for (const f of found) {
            if (kind === 'phone' && f.value.replace(/\D/g, '').length < 9) continue;
            if (kind === 'amount' && !/\d/.test(f.value)) continue;
            const key = f.value.toLowerCase().replace(/\s+/g, ' ');
            const existing = entities[kind].get(key);
            if (existing) { existing.count++; continue; }
            let context = sents.find((s) => s.includes(f.value)) || t;
            if (context.length > 220) {
              const pos = context.indexOf(f.value);
              const from = Math.max(0, pos - 100);
              context = (from > 0 ? '… ' : '') + context.slice(from, from + 220).trim() + (from + 220 < context.length ? ' …' : '');
            }
            entities[kind].set(key, { value: f.value, context, section: si, count: 1 });
          }
        }
      }
    });
    const ent = Object.fromEntries(Object.entries(entities).map(([k, m]) => [k, [...m.values()]]));

    // Statistiques et lisibilité
    const sentenceCount = Math.max(sentences.length, 1);
    const sentWords = sentences.reduce((a, s) => a + words(s.text).length, 0) || 1;
    const wps = sentWords / sentenceCount;
    const spw = syllables / sentWords;
    const readScore = lang === 'fr' ? 207 - 1.015 * wps - 73.6 * spw : 206.835 - 1.015 * wps - 84.6 * spw;
    const paragraphs = sections.reduce((a, s) => a + s.blocks.filter((b) => b.type === 'para').length, 0);
    const tables = sections.reduce((a, s) => a + s.blocks.filter((b) => b.type === 'table').length, 0);

    return {
      title: title || (parsed.fileName ? parsed.fileName.replace(/\.[^.]+$/, '') : 'Document analysé'),
      fileName: parsed.fileName,
      lang,
      sections,
      sectionSummaries,
      summary,
      keywords,
      actions,
      entities: ent,
      stats: {
        words: wordCount,
        sentences: sentences.length,
        paragraphs,
        sections: sections.filter((s) => s.title).length,
        tables,
        readingMinutes: Math.max(1, Math.round(wordCount / 230)),
        avgSentenceWords: Math.round(wps),
        readability: { score: Math.round(Math.max(0, Math.min(100, readScore))), label: readabilityLabel(readScore) },
      },
      generatedAt: new Date(),
    };
  }

  return { analyze, splitSentences, words };
})();
