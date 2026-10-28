/* Interface : chargement du document, analyse, affichage, exports. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('file-input');
  const dropzone = $('dropzone');
  const textInput = $('text-input');
  const output = $('output');
  const status = $('status');
  const exportButtons = [$('btn-export-html'), $('btn-export-md'), $('btn-print')];
  const dzMain = dropzone.querySelector('.dz-main');
  const dzMainDefault = dzMain.innerHTML;

  const style = document.createElement('style');
  style.textContent = Render.DOC_CSS;
  document.head.append(style);

  let loadedFile = null;
  let current = null; // { analysis, article }

  function setStatus(msg, kind = '') {
    status.textContent = msg;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setFile(file) {
    loadedFile = file;
    dropzone.classList.toggle('loaded', !!file);
    if (file) dzMain.textContent = '✓ ' + file.name + ' (' + Math.ceil(file.size / 1024).toLocaleString('fr-FR') + ' Ko)';
    else dzMain.innerHTML = dzMainDefault;
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) { setFile(fileInput.files[0]); analyze(); }
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove('drag')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) { setFile(file); analyze(); }
  });
  // Empêche le navigateur d'ouvrir un fichier lâché à côté de la zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  textInput.addEventListener('input', () => { if (textInput.value.trim() && loadedFile) { setFile(null); fileInput.value = ''; } });

  async function analyze() {
    const text = textInput.value;
    if (!loadedFile && !text.trim()) { setStatus('Choisissez un fichier ou collez un texte.', 'error'); return; }
    setStatus('Analyse en cours…');
    try {
      const t0 = performance.now();
      const parsed = loadedFile ? await Parsers.parseFile(loadedFile) : Parsers.parseText(text);
      if (!parsed.blocks.length) throw new Error('Aucun texte exploitable trouvé dans ce document.');
      const opts = { summaryLength: $('summary-length').value, sectionSummaries: $('opt-section-summaries').checked };
      const analysis = Analyzer.analyze(parsed, opts);
      const article = Render.renderDocument(analysis, opts);
      output.replaceChildren(article);
      current = { analysis, article, opts };
      exportButtons.forEach((b) => (b.disabled = false));
      setStatus('Analyse terminée en ' + Math.round(performance.now() - t0) + ' ms — ' +
        analysis.stats.words.toLocaleString('fr-FR') + ' mots, ' + analysis.sections.length + ' section(s).', 'ok');
      if (window.matchMedia('(max-width: 860px)').matches) output.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Erreur pendant l\'analyse.', 'error');
    }
  }

  function download(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const baseName = () => (current.analysis.title || 'document').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) + ' - synthese';

  $('btn-analyze').addEventListener('click', analyze);
  ['summary-length', 'opt-section-summaries'].forEach((id) => $(id).addEventListener('change', () => { if (current) analyze(); }));

  $('btn-export-html').addEventListener('click', () => {
    if (current) download(Render.toHtmlFile(current.article, current.analysis.title), baseName() + '.html', 'text/html;charset=utf-8');
  });
  $('btn-export-md').addEventListener('click', () => {
    if (current) download(Render.toMarkdown(current.analysis, current.opts), baseName() + '.md', 'text/markdown;charset=utf-8');
  });
  $('btn-print').addEventListener('click', () => window.print());

  $('btn-clear').addEventListener('click', () => {
    setFile(null);
    fileInput.value = '';
    textInput.value = '';
    current = null;
    exportButtons.forEach((b) => (b.disabled = true));
    output.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'placeholder',
      textContent: 'Données effacées. Chargez un nouveau document pour recommencer.',
    }));
    setStatus('Toutes les données ont été effacées de la page.', 'ok');
  });
})();
