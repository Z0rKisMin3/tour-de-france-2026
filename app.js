'use strict';

// ================================================================
// CONFIG SUPABASE
// ================================================================
const SUPA_URL = 'https://gvpoznbiikpdhlrircny.supabase.co';
const SUPA_KEY = 'sb_publishable_lnpPSZlUMN05j563uGdSFg_m4DNNwXV';
const HEADERS = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

const LS_SESSION = 'tdf2026_session';
const LS_ORGA = 'tdf2026_orga';
const LEGAL_VERSION = '1.0-2026-06-28';

// ================================================================
// CONSTANTES MÉTIER
// ================================================================
const FINAL_GAP_RANGES = [
  'Moins de 1 minute', '1 min à 2 min 59', '3 min à 4 min 59',
  '5 min à 9 min 59', '10 min à 19 min 59', '20 minutes ou plus'
];
const STAGE_GAP_RANGES = [
  'Même temps', '1 à 5 secondes', '6 à 15 secondes',
  '16 à 30 secondes', '31 sec à 1 minute', 'Plus d\'une minute'
];
const STAGE_TYPES = {
  plaine:     { label: 'Plaine',           coefficient: 1.00, color: 'type-plaine' },
  accidentee: { label: 'Accidentée',       coefficient: 1.15, color: 'type-accidentee' },
  montagne:   { label: 'Montagne',         coefficient: 1.35, color: 'type-montagne' },
  clm:        { label: 'Contre-la-montre', coefficient: 1.25, color: 'type-clm' }
};
const FINISH_TYPES = ['Sprint', 'Échappée', 'Montagne', 'Contre-la-montre'];

// ================================================================
// ÉTAT
// ================================================================
let db = {
  season: null,             // métadonnées de la saison active (nom, dates, nb attendus…)
  teams: [], riders: [], stages: [], players: [],
  pretourResults: null, stageResults: {},
  pretourPredictions: {},   // { playerId: data }  (public = verrouillés seulement)
  stagePredictions: {}      // { 'playerId_stageId': data }  (public = verrouillés)
};
let session = null;          // { token, id, name, approved }
let myPretour = null;        // mon prono avant départ (toujours accessible)
let myStages = {};           // { stageId: data }
let orgaCode = null;         // code organisateur si activé

// ================================================================
// HELPERS SUPABASE
// ================================================================
async function sbSelect(table, query = 'select=*') {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, { headers: HEADERS });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function rpc(fn, body) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) throw new Error((data && data.message) || txt || 'Erreur serveur');
  return data;
}

// ================================================================
// UTILS
// ================================================================
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}
function showModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modal').style.display = 'flex';
}
function closeModal() { document.getElementById('modal').style.display = 'none'; }

function getRiderName(id) { const r = db.riders.find(r => r.id === id); return r ? riderDisplay(r.name) : (id ? '?' : '—'); }
function getTeamName(id) { const t = db.teams.find(t => t.id === id); return t ? t.name : (id ? '?' : '—'); }

// Porteurs actuels des maillots = d'après le résultat de la dernière étape encodée
function currentJerseys() {
  const done = db.stages.filter(s => db.stageResults[s.id]).sort((a, b) => (b.number || 0) - (a.number || 0));
  if (!done.length) return {};
  const r = db.stageResults[done[0].id] || {};
  return { yellow: r.yellowJerseyAfter, green: r.greenJerseyAfter, polka: r.polkaJerseyAfter, white: r.whiteJerseyAfter };
}
function riderJerseyBadges(id, j) {
  let s = '';
  if (j.yellow === id) s += ' <span title="Maillot jaune">🟡</span>';
  if (j.green === id) s += ' <span title="Maillot vert">🟢</span>';
  if (j.polka === id) s += ' <span title="Maillot à pois">🔴</span>';
  if (j.white === id) s += ' <span title="Maillot blanc">⚪</span>';
  return s;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}
function shortTime(t) { return t ? t.slice(0, 5) : ''; }

function stageLockMs(stage) { return stage && stage.lockUntil ? new Date(stage.lockUntil).getTime() : Infinity; }
function isStageLocked(stage) { return Date.now() >= stageLockMs(stage); }
function preTourLockMs() {
  if (!db.stages.length) return Infinity;
  return Math.min(...db.stages.map(stageLockMs));
}
function isPreTourLocked() { return Date.now() >= preTourLockMs(); }

// Clé de tri = nom de famille (tout ce qui suit le prénom), insensible à la casse/accents.
// Gère les noms composés (« van der Poel », « De Lie », « Kragh Andersen »…).
function lastNameKey(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return (parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '');
}
function byLastName(a, b) {
  return lastNameKey(a.name).localeCompare(lastNameKey(b.name), 'fr', { sensitivity: 'base' });
}
// Affichage « Nom Prénom » (ex. "Tadej Pogačar" -> "Pogačar Tadej", "Mathieu van der Poel" -> "van der Poel Mathieu")
function riderDisplay(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return name || '';
  return parts.slice(1).join(' ') + ' ' + parts[0];
}

// selects
function riderSelect(name, sel, ph = '— Choisir un coureur —', attrs = '') {
  // Coureurs actifs d'abord (triés par nom), puis abandons en bas
  const rs = [...db.riders].sort((a, b) => {
    const ao = a.active === false, bo = b.active === false;
    if (ao !== bo) return ao ? 1 : -1;
    return byLastName(a, b);
  });
  return `<select name="${esc(name)}" ${attrs}><option value="">${esc(ph)}</option>${rs.map(r => {
    const out = r.active === false;
    const nat = r.nationality ? ' (' + esc(r.nationality) + ')' : '';
    return `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''} ${out ? 'style="color:#E8373A"' : ''}>${out ? '⛔ ' : ''}${esc(riderDisplay(r.name))}${nat}${out ? ' — ABANDON' : ''}</option>`;
  }).join('')}</select>`;
}
function teamSelect(name, sel, ph = '— Choisir une équipe —') {
  const ts = [...db.teams].sort((a, b) => a.name.localeCompare(b.name));
  return `<select name="${esc(name)}"><option value="">${esc(ph)}</option>${ts.map(t =>
    `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>`;
}
function rangeSelect(name, sel, ranges) {
  return `<select name="${esc(name)}"><option value="">— Choisir —</option>${ranges.map(r =>
    `<option value="${esc(r)}" ${r === sel ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
}
function boolSelect(name, sel) {
  return `<select name="${esc(name)}"><option value="">— Choisir —</option>
    <option value="oui" ${sel === 'oui' ? 'selected' : ''}>Oui</option>
    <option value="non" ${sel === 'non' ? 'selected' : ''}>Non</option></select>`;
}
// Vainqueur final du Tour → renseigne automatiquement le 1er du podium ET le 1er du Top 10
function onPreTourWinnerChange(sel) {
  const form = sel.closest('form');
  if (!form) return;
  const p0 = form.querySelector('[name="pod0"]');
  if (p0) p0.value = sel.value;
  const t0 = form.querySelector('[name="top10_0"]');
  if (t0) t0.value = sel.value;
}
// Vainqueur d'étape → renseigne automatiquement le 1er du Top 3 et l'équipe du vainqueur
function onStageWinnerChange(sel) {
  const rid = sel.value;
  const form = sel.closest('form');
  if (!form) return;
  const t0 = form.querySelector('[name="top3_0"]');
  if (t0) t0.value = rid;
  const wt = form.querySelector('[name="winnerTeam"]');
  const rider = db.riders.find(r => r.id === rid);
  if (wt) wt.value = rider && rider.teamId ? rider.teamId : '';
}

// ================================================================
// MOTEUR DE SCORE (identique au barème du règlement)
// ================================================================
function getPodiumScore(pred, off) {
  if (!pred || !off || pred.length < 3 || off.length < 3) return 0;
  const p = pred.slice(0, 3), o = off.slice(0, 3);
  if (p[0] === o[0] && p[1] === o[1] && p[2] === o[2]) return 90;
  const present = p.filter(id => id && o.includes(id)).length;
  return present === 3 ? 60 : present === 2 ? 35 : present === 1 ? 15 : 0;
}
function getTop10Score(pred, off) {
  if (!pred || !off) return 0;
  const o = new Set(off.filter(Boolean));
  return Math.min(pred.filter(id => id && o.has(id)).length * 10, 100);
}
function getStageTop3Score(pred, off) {
  if (!pred || !off || pred.length < 3 || off.length < 3) return 0;
  const p = pred.slice(0, 3), o = off.slice(0, 3);
  if (p[0] === o[0] && p[1] === o[1] && p[2] === o[2]) return 20;
  const present = p.filter(id => id && o.includes(id)).length;
  return present === 3 ? 15 : present === 2 ? 10 : present === 1 ? 5 : 0;
}
function isNeighborRange(pred, off, ranges) {
  const pi = ranges.indexOf(pred), oi = ranges.indexOf(off);
  return pi !== -1 && oi !== -1 && Math.abs(pi - oi) === 1;
}
function getRangeScore(pred, off, ranges, exact, neighbor = 0) {
  if (!pred || !off) return 0;
  if (pred === off) return exact;
  if (neighbor > 0 && isNeighborRange(pred, off, ranges)) return neighbor;
  return 0;
}
function calculatePreTourScore(pred, res) {
  if (!pred || !res) return { total: 0, detail: {} };
  const d = {};
  const eq = (a, b) => a && b && a === b;
  d.winner = eq(pred.winner, res.winner) ? 100 : 0;
  d.podium = getPodiumScore(pred.podium, res.podium);
  d.top10 = getTop10Score(pred.top10, res.top10);
  d.greenJersey = eq(pred.greenJersey, res.greenJersey) ? 50 : 0;
  d.polkaDotJersey = eq(pred.polkaDotJersey, res.polkaDotJersey) ? 50 : 0;
  d.whiteJersey = eq(pred.whiteJersey, res.whiteJersey) ? 40 : 0;
  d.bestTeam = eq(pred.bestTeam, res.bestTeam) ? 30 : 0;
  d.superCombative = eq(pred.superCombative, res.superCombative) ? 30 : 0;
  d.mostStageWinsRider = eq(pred.mostStageWinsRider, res.mostStageWinsRider) ? 30 : 0;
  d.mostStageWinsTeam = eq(pred.mostStageWinsTeam, res.mostStageWinsTeam) ? 30 : 0;
  d.belgianWins = (pred.belgianWins !== '' && pred.belgianWins != null && String(pred.belgianWins) === String(res.belgianWins)) ? 20 : 0;
  d.abandonCount = (pred.abandonCount !== '' && pred.abandonCount != null && String(pred.abandonCount) === String(res.abandonCount)) ? 20 : 0;
  d.finalGap = getRangeScore(pred.finalGapRange, res.finalGapRange, FINAL_GAP_RANGES, 20, 10);
  return { total: Object.values(d).reduce((s, v) => s + v, 0), detail: d };
}
function calculateStageRawScore(pred, res, stage) {
  if (!pred || !res || !stage) return { raw: 0, detail: {} };
  const d = {};
  const eq = (a, b) => a && b && a === b;
  d.winner = eq(pred.stageWinner, res.winner) ? 25 : 0;
  d.top3 = getStageTop3Score(pred.stageTop3, res.top3);
  if (stage.type !== 'clm') d.finishType = eq(pred.finishType, res.finishType) ? 10 : 0;
  d.yellowJersey = eq(pred.yellowJerseyAfter, res.yellowJerseyAfter) ? 10 : 0;
  d.yellowChanged = eq(pred.yellowChanged, res.yellowChanged) ? 5 : 0;
  d.fromBreakaway = eq(pred.winnerFromBreakaway, res.winnerFromBreakaway) ? 5 : 0;
  d.gapRange = getRangeScore(pred.gapRange, res.gapRange, STAGE_GAP_RANGES, 5, 0);
  d.winnerTeam = eq(pred.winnerTeam, res.winnerTeam) ? 5 : 0;
  d.mostCombative = eq(pred.mostCombative, res.mostCombative) ? 5 : 0;
  d.winnerTime = eq(pred.winnerTime, res.winnerTime) ? 5 : 0;
  if (stage.enableLastClimbPrediction) d.lastClimb = eq(pred.lastClimbFirst, res.lastClimbFirst) ? 5 : 0;
  if (stage.enableGreenJerseyChangePrediction) d.greenChanged = eq(pred.greenChanged, res.greenChanged) ? 5 : 0;
  return { raw: Object.values(d).reduce((s, v) => s + v, 0), detail: d };
}
function applyStageCoefficient(raw, stage) {
  return Math.round(raw * (STAGE_TYPES[stage.type] || STAGE_TYPES.plaine).coefficient);
}
function calculatePlayerTotal(playerId) {
  let total = 0, preTourPts = 0; const stageBreakdown = {};
  const pred = db.pretourPredictions[playerId];
  if (pred && db.pretourResults) { preTourPts = calculatePreTourScore(pred, db.pretourResults).total; total += preTourPts; }
  for (const stage of db.stages) {
    const sp = db.stagePredictions[playerId + '_' + stage.id];
    const sr = db.stageResults[stage.id];
    if (sp && sr) { const { raw } = calculateStageRawScore(sp, sr, stage); const pts = applyStageCoefficient(raw, stage); stageBreakdown[stage.id] = pts; total += pts; }
  }
  return { total, preTourPts, stageBreakdown };
}
function validateUniqueSelection(values) {
  const ne = values.filter(v => v);
  return ne.length === new Set(ne).size;
}

// ================================================================
// CHARGEMENT DES DONNÉES
// ================================================================
async function loadAll() {
  const [seasons, teams, riders, stages, players, ptres, stres, ptpreds, stpreds] = await Promise.all([
    sbSelect('seasons', 'select=*&is_active=eq.true'),
    sbSelect('teams'),
    sbSelect('riders'),
    sbSelect('stages', 'select=*&order=number.asc'),
    sbSelect('players', 'select=id,name,approved&order=created_at.asc'),
    sbSelect('pretour_results'),
    sbSelect('stage_results'),
    sbSelect('pretour_predictions'),   // RLS: renvoie seulement si verrouillé
    sbSelect('stage_predictions')      // RLS: renvoie seulement étapes verrouillées
  ]);

  db.season = seasons.length ? seasons[0] : null;
  db.teams = teams;
  db.riders = riders.map(r => ({ id: r.id, name: r.name, nationality: r.nationality, teamId: r.team_id, active: r.active !== false }));
  db.stages = stages.map(s => ({
    id: s.id, number: s.number, date: s.date, startTime: s.start_time, title: s.title,
    type: s.type, coefficient: Number(s.coefficient),
    enableLastClimbPrediction: s.enable_last_climb,
    enableGreenJerseyChangePrediction: s.enable_green_jersey,
    lockUntil: s.lock_until,
    distanceKm: s.distance_km, elevationM: s.elevation_m, details: s.details, profileUrl: s.profile_url,
    profilePoints: s.profile_points
  }));
  db.players = players;
  db.pretourResults = ptres.length ? ptres[0].data : null;
  db.stageResults = {}; stres.forEach(r => { db.stageResults[r.stage_id] = r.data; });
  db.pretourPredictions = {}; ptpreds.forEach(p => { db.pretourPredictions[p.player_id] = p.data; });
  db.stagePredictions = {}; stpreds.forEach(p => { db.stagePredictions[p.player_id + '_' + p.stage_id] = p.data; });

  // Mes pronos (accessibles même non verrouillés) + injection dans les maps publiques
  if (session) {
    try {
      const mine = await rpc('get_my_predictions', { p_token: session.token });
      myPretour = mine.pretour || null;
      myStages = mine.stages || {};
      if (myPretour) db.pretourPredictions[session.id] = myPretour;
      Object.entries(myStages).forEach(([sid, data]) => { db.stagePredictions[session.id + '_' + sid] = data; });
    } catch (e) { /* session expirée gérée ailleurs */ }
  }
}

// ================================================================
// SESSION / AUTH
// ================================================================
function loadSession() {
  try { session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch { session = null; }
  orgaCode = localStorage.getItem(LS_ORGA) || null;
}
function saveSession() {
  if (session) localStorage.setItem(LS_SESSION, JSON.stringify(session));
  else localStorage.removeItem(LS_SESSION);
}

async function refreshWhoami() {
  if (!session) return;
  try {
    const w = await rpc('whoami', { p_token: session.token });
    if (!w) { session = null; saveSession(); return; }
    session.approved = w.approved; session.name = w.name; saveSession();
  } catch { /* ignore */ }
}

function openAuth(mode) {
  const isReg = mode === 'register';
  showModal(`
    <div class="card-title" style="margin-bottom:14px">${isReg ? 'Créer un compte' : 'Se connecter'}</div>
    <div class="form-group"><label>Pseudo</label><input type="text" id="authName" maxlength="40" autocomplete="username"></div>
    ${isReg ? `<div class="form-group"><label>Email (facultatif, pour récupération)</label><input type="email" id="authEmail" maxlength="120"></div>` : ''}
    <div class="form-group"><label>Mot de passe</label><input type="password" id="authPass" maxlength="80" autocomplete="${isReg ? 'new-password' : 'current-password'}"></div>
    ${isReg ? `<div class="form-group"><label>Présentation (facultatif)</label><textarea id="authNote" rows="2" maxlength="300" placeholder="Es-tu parent / ami / connaissance de quelqu'un ? Précise-le pour faciliter la validation de ton inscription."></textarea></div>` : ''}
    ${isReg ? `<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-size:13px;cursor:pointer">
      <input type="checkbox" id="authLegal" style="margin-top:3px">
      <span>J'ai lu et j'accepte le <a href="legal/reglement.html" target="_blank" rel="noopener" style="color:var(--yellow)">règlement</a> de l'application « Pronostics Tour 2026 » (et les <a href="legal/index.html" target="_blank" rel="noopener" style="color:var(--yellow)">documents associés</a>).</span>
    </label>` : ''}
    ${isReg ? `<div class="alert alert-info" style="margin:6px 0 12px">ℹ️ Ton inscription devra être validée par l'organisateur avant de pouvoir pronostiquer.</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn btn-primary" onclick="${isReg ? 'doRegister()' : 'doLogin()'}">${isReg ? 'Créer mon compte' : 'Connexion'}</button>
      <button class="btn btn-outline" onclick="closeModal()">Annuler</button>
    </div>
    <div style="margin-top:12px;font-size:12px;color:var(--muted)">
      ${isReg ? 'Déjà un compte ? <a href="#" onclick="openAuth(\'login\');return false" style="color:var(--yellow)">Se connecter</a>'
              : 'Pas encore de compte ? <a href="#" onclick="openAuth(\'register\');return false" style="color:var(--yellow)">S\'inscrire</a>'}
    </div>`);
  setTimeout(() => { const el = document.getElementById('authName'); if (el) el.focus(); }, 50);
}

async function doRegister() {
  const name = document.getElementById('authName').value.trim();
  const email = (document.getElementById('authEmail').value || '').trim();
  const pass = document.getElementById('authPass').value;
  if (name.length < 2) return showToast('Pseudo trop court', 'error');
  if (pass.length < 4) return showToast('Mot de passe trop court (min 4)', 'error');
  const legal = document.getElementById('authLegal');
  if (!legal || !legal.checked) return showToast('Tu dois accepter le règlement pour t\'inscrire', 'error');
  try {
    const noteEl = document.getElementById('authNote');
    const note = noteEl ? noteEl.value.trim() : '';
    const res = await rpc('register_player', { p_name: name, p_email: email, p_password: pass, p_legal_version: LEGAL_VERSION, p_note: note });
    session = { token: res.token, id: res.id, name: res.name, approved: res.approved };
    saveSession(); closeModal();
    showToast('Compte créé ! En attente de validation.', 'success');
    await loadAll(); renderShell(); showTab('dashboard');
  } catch (e) { showToast(e.message, 'error'); }
}
async function doLogin() {
  const name = document.getElementById('authName').value.trim();
  const pass = document.getElementById('authPass').value;
  try {
    const res = await rpc('login_player', { p_name: name, p_password: pass });
    session = { token: res.token, id: res.id, name: res.name, approved: res.approved };
    saveSession(); closeModal();
    showToast('Connecté !', 'success');
    await loadAll(); renderShell(); showTab('dashboard');
  } catch (e) { showToast(e.message, 'error'); }
}
function logout() {
  session = null; myPretour = null; myStages = {}; saveSession();
  showToast('Déconnecté', '');
  loadAll().then(() => { renderShell(); showTab('dashboard'); });
}

// Organisateur
function toggleOrga() {
  if (orgaCode) {
    orgaCode = null; localStorage.removeItem(LS_ORGA);
    showToast('Mode organisateur désactivé', '');
    renderShell(); showTab('dashboard');
  } else {
    const code = prompt('Code organisateur :');
    if (!code) return;
    // Validation par un appel test
    rpc('admin_list_registrations', { p_code: code }).then(() => {
      orgaCode = code; localStorage.setItem(LS_ORGA, code);
      showToast('Mode organisateur activé !', 'success');
      renderShell(); showTab('registrations');
    }).catch(() => showToast('Code incorrect', 'error'));
  }
}

// ================================================================
// SHELL (header + nav)
// ================================================================
function renderShell() {
  // Header
  const ha = document.getElementById('headerActions');
  let h = '';
  if (session) {
    const badge = session.approved ? '' : ' <span class="badge badge-red" style="margin-left:4px">en attente</span>';
    h += `<span style="font-size:13px;color:var(--text);margin-right:4px">👤 <strong>${esc(session.name)}</strong>${badge}</span>`;
    h += `<button class="btn btn-sm btn-outline" onclick="logout()">Déconnexion</button>`;
  } else {
    h += `<button class="btn btn-sm btn-outline" onclick="openAuth('login')">Se connecter</button>`;
    h += `<button class="btn btn-sm btn-primary" onclick="openAuth('register')">S'inscrire</button>`;
  }
  h += `<button class="btn btn-sm ${orgaCode ? 'btn-primary' : 'btn-outline'}" onclick="toggleOrga()">${orgaCode ? '🔓 Orga' : '🔑'}</button>`;
  ha.innerHTML = h;

  // Nav
  const tabs = [
    ['dashboard', '🏠 Accueil'],
    ['pronos', '📝 Pronostics'],
    ['ranking', '🏆 Classement'],
    ['scores', '📊 Détail'],
    ['riders', '🚴 Coureurs'],
    ['stages', '📅 Étapes'],
    ['rules', '📜 Règlement']
  ];
  if (orgaCode) {
    tabs.push(['registrations', '🛂 Joueurs']);
    tabs.push(['results', '✅ Résultats']);
  }
  document.getElementById('navInner').innerHTML = tabs.map(([id, label]) =>
    `<button class="tab-btn ${id === currentTab ? 'active' : ''}" data-tab="${id}" onclick="showTab('${id}')">${label}</button>`).join('');
}

// ================================================================
// NAVIGATION
// ================================================================
let currentTab = 'dashboard';
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const main = document.getElementById('mainContent');
  const r = {
    dashboard: renderDashboard, pronos: renderPronos,
    ranking: renderRanking, scores: renderScoreDetail, riders: renderRiders, stages: renderStages,
    rules: renderRules, registrations: renderRegistrations, results: renderResults
  }[tab];
  main.innerHTML = '';
  if (r) r(main);
}

// pending banner helper
function pendingBanner() {
  if (session && !session.approved) {
    return `<div class="alert alert-warning">⏳ Ton compte est <strong>en attente de validation</strong> par l'organisateur. Tu peux tout consulter, mais tu ne pourras pronostiquer qu'une fois validé.</div>`;
  }
  return '';
}

// ================================================================
// ONGLET : ACCUEIL
// ================================================================
function renderDashboard(el) {
  const scores = {}; db.players.forEach(p => scores[p.id] = calculatePlayerTotal(p.id));
  const sorted = [...db.players].sort((a, b) => scores[b.id].total - scores[a.id].total);
  const upcoming = db.stages.filter(s => !isStageLocked(s)).sort((a, b) => stageLockMs(a) - stageLockMs(b));
  const done = db.stages.filter(s => db.stageResults[s.id]).sort((a, b) => stageLockMs(b) - stageLockMs(a));
  const ptLocked = isPreTourLocked();

  let html = pendingBanner();
  if (!session) html += `<div class="alert alert-info">👋 Bienvenue ! <a href="#" onclick="openAuth('register');return false" style="color:var(--yellow)">Crée un compte</a> ou <a href="#" onclick="openAuth('login');return false" style="color:var(--yellow)">connecte-toi</a> pour pronostiquer. Tu peux consulter le classement et le parcours librement.</div>`;

  const sz = db.season || {};
  const exp = (cur, target) => target ? `${cur}<span style="font-size:13px;color:var(--muted)"> / ${target}</span>` : `${cur}`;
  html += `<div class="stats-row">
    <div class="stat-box"><div class="stat-label">Joueurs</div><div class="stat-value">${db.players.length}</div></div>
    <div class="stat-box"><div class="stat-label">Étapes</div><div class="stat-value">${exp(db.stages.length, sz.nb_stages)}</div></div>
    <div class="stat-box"><div class="stat-label">Équipes</div><div class="stat-value">${exp(db.teams.length, sz.nb_teams)}</div></div>
    <div class="stat-box"><div class="stat-label">Coureurs</div><div class="stat-value">${exp(db.riders.length, sz.nb_riders)}</div></div>
  </div>`;
  if (sz.nb_riders && db.riders.length < sz.nb_riders) {
    html += `<div class="alert alert-info">ℹ️ Effectif provisoire : <strong>${db.riders.length}/${sz.nb_riders}</strong> coureurs. Les startlists officielles (8 par équipe) sont confirmées juste avant le Grand Départ — l'effectif sera complété automatiquement le 2 juillet.</div>`;
  }

  html += `<div class="alert ${ptLocked ? 'alert-danger' : 'alert-success'}">${ptLocked ? '🔒 Pronostics avant départ <strong>verrouillés</strong> — le Tour a commencé' : '🟢 Pronostics avant départ <strong>ouverts</strong> jusqu\'au départ de l\'étape 1'}</div>`;

  html += `<div class="grid-2">`;

  html += `<div class="card"><div class="card-title">🏆 Classement général</div>`;
  if (!sorted.length) html += `<div class="empty-state"><p>Aucun joueur inscrit</p></div>`;
  else {
    html += `<table><thead><tr><th>#</th><th>Joueur</th><th style="text-align:right">Points</th></tr></thead><tbody>`;
    sorted.slice(0, 10).forEach((p, i) => {
      const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      html += `<tr><td class="rank-pos ${medal}">${i + 1}</td><td class="rank-name">${esc(p.name)}${session && p.id === session.id ? ' <span class="badge badge-yellow">moi</span>' : ''}</td><td class="rank-pts">${scores[p.id].total}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;

  html += `<div class="card"><div class="card-title">📅 Prochaines étapes</div>`;
  if (!upcoming.length) html += `<div class="empty-state"><p>Aucune étape à venir</p></div>`;
  else upcoming.slice(0, 5).forEach(s => {
    const ti = STAGE_TYPES[s.type] || STAGE_TYPES.plaine;
    html += `<div class="stage-card"><div class="stage-num">É${s.number}</div><div class="stage-info"><div class="stage-title">${esc(s.title)}</div><div class="stage-meta">${formatDate(s.date)} · ${shortTime(s.startTime)} · <span class="${ti.color}">${ti.label}</span></div></div><span class="badge badge-open">Ouvert</span></div>`;
  });
  html += `</div>`;

  html += `<div class="card"><div class="card-title">✅ Dernières étapes courues</div>`;
  if (!done.length) html += `<div class="empty-state"><p>Aucun résultat encodé</p></div>`;
  else done.slice(0, 4).forEach(s => {
    const r = db.stageResults[s.id];
    html += `<div class="stage-card"><div class="stage-num">É${s.number}</div><div class="stage-info"><div class="stage-title">${esc(s.title)}</div><div class="stage-meta">Vainqueur : <strong>${esc(getRiderName(r.winner))}</strong></div></div><span class="badge badge-locked">Terminée</span></div>`;
  });
  html += `</div>`;

  html += `<div class="card"><div class="card-title">⚡ Accès rapide</div><div style="display:flex;flex-direction:column;gap:8px">
    <button class="btn btn-outline" onclick="goPronos('pretour')">🏁 Mon prono avant départ</button>
    <button class="btn btn-outline" onclick="goPronos('stage')">📝 Mes pronos d'étape</button>
    <button class="btn btn-outline" onclick="showTab('rules')">📜 Règlement</button>
  </div></div>`;

  html += `</div>`;
  el.innerHTML = html;
}

// ================================================================
// ONGLET : PRONOSTICS (regroupe Avant départ + Par étape)
// ================================================================
let pronosSub = 'pretour';
function renderPronos(el) {
  el.innerHTML = `<div class="sub-tabs">
    <button class="sub-tab-btn ${pronosSub === 'pretour' ? 'active' : ''}" id="psPre" onclick="showPronosSub('pretour')">🏁 Avant départ</button>
    <button class="sub-tab-btn ${pronosSub === 'stage' ? 'active' : ''}" id="psStage" onclick="showPronosSub('stage')">📅 Par étape</button>
  </div><div id="pronosSub"></div>`;
  showPronosSub(pronosSub);
}
function showPronosSub(which) {
  pronosSub = which;
  const a = document.getElementById('psPre'), b = document.getElementById('psStage');
  if (a) a.classList.toggle('active', which === 'pretour');
  if (b) b.classList.toggle('active', which === 'stage');
  const sub = document.getElementById('pronosSub');
  if (!sub) return;
  if (which === 'pretour') renderPreTour(sub); else renderStagePronostics(sub);
}
function goPronos(which) { showTab('pronos'); showPronosSub(which); }

// ================================================================
// SOUS-ONGLET : AVANT DÉPART (mon prono)
// ================================================================
function renderPreTour(el) {
  if (!session) { el.innerHTML = `<div class="alert alert-info">Connecte-toi pour encoder tes pronostics. <button class="btn btn-sm btn-primary" onclick="openAuth('login')">Se connecter</button></div>`; return; }
  if (!session.approved) { el.innerHTML = pendingBanner(); return; }

  const locked = isPreTourLocked();
  const pred = myPretour || {};
  let html = `<div class="section-header"><div class="section-title">🏁 Mes pronostics avant le départ</div>
    <button class="btn btn-sm btn-danger" onclick="resetPreTour()" ${locked ? 'disabled' : ''} title="${locked ? 'Verrouillé : le Tour a commencé' : 'Effacer tous mes pronostics avant départ'}">🗑️ Réinitialiser</button>
  </div>`;
  if (locked) html += `<div class="alert alert-danger">🔒 Verrouillés — le Tour a commencé. Tu ne peux plus modifier.</div>`;
  else html += `<div class="alert alert-info">Tu peux modifier tes choix jusqu'au départ de l'étape 1 (${formatDate(db.stages[0] && db.stages[0].date)} ${shortTime(db.stages[0] && db.stages[0].startTime)}).</div>`;

  html += `<form id="ptForm" onsubmit="savePreTour(event)">`;
  html += `<div class="pred-section"><div class="pred-section-title">🥇 Classement général</div>
    <div class="form-group"><label>Vainqueur final <span class="pts-label">100 pts</span></label>${riderSelect('winner', pred.winner, undefined, 'onchange="onPreTourWinnerChange(this)"')}</div>
    <div class="form-group"><label>Podium — 1er <span class="pts-label">→ 90 pts max · rempli auto par le vainqueur</span></label>${riderSelect('pod0', pred.podium && pred.podium[0])}</div>
    <div class="form-group"><label>Podium — 2e</label>${riderSelect('pod1', pred.podium && pred.podium[1])}</div>
    <div class="form-group"><label>Podium — 3e</label>${riderSelect('pod2', pred.podium && pred.podium[2])}</div></div>`;

  html += `<div class="pred-section"><div class="pred-section-title">🔟 Top 10 final <span class="pts-label" style="color:var(--muted)">10 pts/coureur · max 100</span></div>`;
  for (let i = 0; i < 10; i++) html += `<div class="form-group"><label>Top 10 — n°${i + 1}${i === 0 ? ' <span class="pts-label">rempli auto par le vainqueur</span>' : ''}</label>${riderSelect('top10_' + i, pred.top10 && pred.top10[i])}</div>`;
  html += `</div>`;

  html += `<div class="pred-section"><div class="pred-section-title">🎽 Maillots</div>
    <div class="form-group"><label>Maillot vert <span class="pts-label">50 pts</span></label>${riderSelect('greenJersey', pred.greenJersey)}</div>
    <div class="form-group"><label>Maillot à pois <span class="pts-label">50 pts</span></label>${riderSelect('polkaDotJersey', pred.polkaDotJersey)}</div>
    <div class="form-group"><label>Maillot blanc <span class="pts-label">40 pts</span></label>${riderSelect('whiteJersey', pred.whiteJersey)}</div></div>`;

  html += `<div class="pred-section"><div class="pred-section-title">🏆 Équipes & Prix</div>
    <div class="form-group"><label>Meilleure équipe <span class="pts-label">30 pts</span></label>${teamSelect('bestTeam', pred.bestTeam)}</div>
    <div class="form-group"><label>Super combatif <span class="pts-label">30 pts</span></label>${riderSelect('superCombative', pred.superCombative)}</div>
    <div class="form-group"><label>Coureur le + de victoires d'étapes <span class="pts-label">30 pts</span></label>${riderSelect('mostStageWinsRider', pred.mostStageWinsRider)}</div>
    <div class="form-group"><label>Équipe la + de victoires d'étapes <span class="pts-label">30 pts</span></label>${teamSelect('mostStageWinsTeam', pred.mostStageWinsTeam)}</div></div>`;

  html += `<div class="pred-section"><div class="pred-section-title">📊 Statistiques</div>
    <div class="form-group"><label>Nombre de victoires belges <span class="pts-label">20 pts</span></label><input type="number" name="belgianWins" min="0" max="21" value="${pred.belgianWins != null ? pred.belgianWins : ''}"></div>
    <div class="form-group"><label>Nombre total d'abandons <span class="pts-label">20 pts</span></label><input type="number" name="abandonCount" min="0" max="184" value="${pred.abandonCount != null ? pred.abandonCount : ''}"></div>
    <div class="form-group"><label>Avance du vainqueur final <span class="pts-label">20 pts (voisine 10)</span></label>${rangeSelect('finalGapRange', pred.finalGapRange, FINAL_GAP_RANGES)}</div></div>`;

  if (!locked) html += `<button type="submit" class="btn btn-primary">💾 Enregistrer mes pronostics</button>`;
  html += `</form>`;
  el.innerHTML = html;
  if (locked) el.querySelectorAll('select,input').forEach(x => x.disabled = true);
}

async function savePreTour(e) {
  e.preventDefault();
  const f = e.target, fv = n => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
  const pod = [fv('pod0'), fv('pod1'), fv('pod2')];
  if (!validateUniqueSelection(pod)) return showToast('Le podium contient des doublons', 'error');
  const top10 = []; for (let i = 0; i < 10; i++) top10.push(fv('top10_' + i));
  if (!validateUniqueSelection(top10)) return showToast('Le Top 10 contient des doublons', 'error');
  if (top10.filter(Boolean).length < 10) return showToast('Le Top 10 doit contenir 10 coureurs', 'error');

  const data = {
    winner: fv('winner'), podium: pod, top10,
    greenJersey: fv('greenJersey'), polkaDotJersey: fv('polkaDotJersey'), whiteJersey: fv('whiteJersey'),
    bestTeam: fv('bestTeam'), superCombative: fv('superCombative'),
    mostStageWinsRider: fv('mostStageWinsRider'), mostStageWinsTeam: fv('mostStageWinsTeam'),
    belgianWins: fv('belgianWins'), abandonCount: fv('abandonCount'), finalGapRange: fv('finalGapRange')
  };
  try {
    await rpc('save_pretour_prediction', { p_token: session.token, p_data: data });
    myPretour = data; db.pretourPredictions[session.id] = data;
    showToast('Pronostics enregistrés !', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function resetPreTour() {
  if (isPreTourLocked()) return showToast('Pronostics verrouillés', 'error');
  if (!myPretour) return showToast('Aucun pronostic à réinitialiser', '');
  if (!confirm('Réinitialiser TOUS tes pronostics avant départ ? Cette action est irréversible.')) return;
  try {
    await rpc('reset_pretour_prediction', { p_token: session.token });
    myPretour = null; delete db.pretourPredictions[session.id];
    showPronosSub('pretour');
    showToast('Pronostics avant départ réinitialisés', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ================================================================
// ONGLET : PAR ÉTAPE (mes pronos)
// ================================================================
function spStatusHTML() {
  const done = db.stages.filter(s => myStages[s.id]).length;
  const total = db.stages.length;
  const chips = db.stages.map(s => {
    const locked = isStageLocked(s);
    const has = !!myStages[s.id];
    const cls = locked ? 'sp-chip locked' : has ? 'sp-chip done' : 'sp-chip todo';
    const icon = locked ? '🔒' : has ? '✅' : '○';
    return `<button class="${cls}" onclick="selectStage('${s.id}')" title="${esc(s.title)}${locked ? ' (verrouillée)' : has ? ' (pronostiquée — cliquer pour modifier)' : ' (à pronostiquer)'}">É${s.number} ${icon}</button>`;
  }).join('');
  return `<div class="alert alert-info" style="margin-bottom:10px">Tu as pronostiqué <strong>${done}/${total}</strong> étapes. Clique sur une étape pour la remplir ou la <strong>modifier</strong> (tant qu'elle n'a pas commencé).<br><span style="font-size:12px;color:var(--muted)">✅ pronostiquée · ○ à faire · 🔒 verrouillée</span></div>
    <div class="sp-chips">${chips}</div>`;
}

function renderStagePronostics(el) {
  if (!session) { el.innerHTML = `<div class="alert alert-info">Connecte-toi pour pronostiquer. <button class="btn btn-sm btn-primary" onclick="openAuth('login')">Se connecter</button></div>`; return; }
  if (!session.approved) { el.innerHTML = pendingBanner(); return; }

  let html = `<div class="section-header"><div class="section-title">📝 Mes pronostics par étape</div></div>
    <div id="spStatus">${spStatusHTML()}</div>
    <div class="form-group" style="max-width:480px"><label>Étape</label>
      <select id="spStage" onchange="renderStageForm()"><option value="">— Choisir une étape —</option>
      ${db.stages.map(s => `<option value="${s.id}">[É${s.number}] ${esc(s.title)} — ${formatDate(s.date)} ${isStageLocked(s) ? '🔒' : myStages[s.id] ? '✅' : '🟢'}</option>`).join('')}
      </select></div><div id="spArea"></div>`;
  el.innerHTML = html;
}

function selectStage(id) {
  const sel = document.getElementById('spStage');
  if (!sel) return;
  sel.value = id;
  renderStageForm();
  const area = document.getElementById('spArea');
  if (area) area.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStageForm() {
  const stageId = document.getElementById('spStage').value;
  const area = document.getElementById('spArea');
  if (!stageId) { area.innerHTML = ''; return; }
  const stage = db.stages.find(s => s.id === stageId);
  const locked = isStageLocked(stage);
  const pred = myStages[stageId] || {};
  const ti = STAGE_TYPES[stage.type] || STAGE_TYPES.plaine;

  let html = `<div class="alert alert-info">Étape ${stage.number} · <strong>${esc(stage.title)}</strong> · ${formatDate(stage.date)} ${shortTime(stage.startTime)} · <span class="${ti.color}">${ti.label}</span> · ×${ti.coefficient.toFixed(2)}${locked ? ' · <strong>🔒 VERROUILLÉE</strong>' : ''}</div>`;
  html += `<form id="spForm" onsubmit="saveStage(event,'${stageId}')">`;

  html += `<div class="pred-section"><div class="pred-section-title">🏁 Résultat de l'étape</div>
    <div class="form-group"><label>Vainqueur <span class="pts-label">25 pts</span></label>${riderSelect('stageWinner', pred.stageWinner, undefined, 'onchange="onStageWinnerChange(this)"')}</div>
    <div class="form-group"><label>Top 3 — 1er <span class="pts-label">→ 20 max · rempli auto par le vainqueur</span></label>${riderSelect('top3_0', pred.stageTop3 && pred.stageTop3[0])}</div>
    <div class="form-group"><label>Top 3 — 2e</label>${riderSelect('top3_1', pred.stageTop3 && pred.stageTop3[1])}</div>
    <div class="form-group"><label>Top 3 — 3e</label>${riderSelect('top3_2', pred.stageTop3 && pred.stageTop3[2])}</div>
    ${stage.type !== 'clm' ? `<div class="form-group"><label>Type d'arrivée <span class="pts-label">10 pts</span></label><select name="finishType"><option value="">— Choisir —</option>${FINISH_TYPES.map(t => `<option value="${esc(t)}" ${t === pred.finishType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>` : ''}
    <div class="form-group"><label>Équipe du vainqueur <span class="pts-label">5 pts · rempli auto</span></label>${teamSelect('winnerTeam', pred.winnerTeam)}</div></div>`;

  html += `<div class="pred-section"><div class="pred-section-title">🟡 Maillot jaune</div>
    <div class="form-group"><label>Porteur après l'étape <span class="pts-label">10 pts</span></label>${riderSelect('yellowJerseyAfter', pred.yellowJerseyAfter)}</div>
    <div class="form-group"><label>Le maillot jaune change-t-il ? <span class="pts-label">5 pts</span></label>${boolSelect('yellowChanged', pred.yellowChanged)}</div></div>`;

  html += `<div class="pred-section"><div class="pred-section-title">📊 Compléments</div>
    <div class="form-group"><label>Vainqueur issu de l'échappée ? <span class="pts-label">5 pts</span></label>${boolSelect('winnerFromBreakaway', pred.winnerFromBreakaway)}</div>
    <div class="form-group"><label>Écart 1er/2e <span class="pts-label">5 pts</span></label>${rangeSelect('gapRange', pred.gapRange, STAGE_GAP_RANGES)}</div>
    <div class="form-group"><label>Plus combatif <span class="pts-label">5 pts</span></label>${riderSelect('mostCombative', pred.mostCombative)}</div>
    <div class="form-group"><label>Temps du vainqueur (hh:mm) <span class="pts-label">5 pts</span></label><input type="time" name="winnerTime" value="${esc(pred.winnerTime || '')}"></div></div>`;

  if (stage.enableLastClimbPrediction)
    html += `<div class="pred-section"><div class="pred-section-title">⛰️ Dernière ascension</div><div class="form-group"><label>Premier au sommet <span class="pts-label">5 pts</span></label>${riderSelect('lastClimbFirst', pred.lastClimbFirst)}</div></div>`;
  if (stage.enableGreenJerseyChangePrediction)
    html += `<div class="pred-section"><div class="pred-section-title">🟢 Maillot vert</div><div class="form-group"><label>Le maillot vert change-t-il ? <span class="pts-label">5 pts</span></label>${boolSelect('greenChanged', pred.greenChanged)}</div></div>`;

  html += `<div style="display:flex;gap:8px;margin-top:8px">`;
  if (!locked) html += `<button type="submit" class="btn btn-primary">💾 Enregistrer</button>`;
  html += `<button type="button" class="btn btn-danger" onclick="resetStage('${stageId}')" ${locked ? 'disabled' : ''} title="${locked ? 'Verrouillé : étape commencée' : 'Effacer mon prono pour cette étape'}">🗑️ Réinitialiser ce prono</button></div>`;
  html += `</form>`;
  area.innerHTML = html;
  if (locked) area.querySelectorAll('select,input,textarea').forEach(x => x.disabled = true);
}

async function resetStage(stageId) {
  const stage = db.stages.find(s => s.id === stageId);
  if (!stage || isStageLocked(stage)) return showToast('Étape verrouillée', 'error');
  if (!myStages[stageId]) return showToast('Aucun pronostic à réinitialiser', '');
  if (!confirm('Réinitialiser ton pronostic pour cette étape ?')) return;
  try {
    await rpc('reset_stage_prediction', { p_token: session.token, p_stage_id: stageId });
    delete myStages[stageId]; delete db.stagePredictions[session.id + '_' + stageId];
    renderStageForm();
    const st = document.getElementById('spStatus'); if (st) st.innerHTML = spStatusHTML();
    showToast('Pronostic réinitialisé', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveStage(e, stageId) {
  e.preventDefault();
  const f = e.target, fv = n => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
  const top3 = [fv('top3_0'), fv('top3_1'), fv('top3_2')];
  if (!validateUniqueSelection(top3)) return showToast('Le Top 3 contient des doublons', 'error');
  const data = {
    stageWinner: fv('stageWinner'), stageTop3: top3, finishType: fv('finishType'),
    yellowJerseyAfter: fv('yellowJerseyAfter'), yellowChanged: fv('yellowChanged'),
    winnerFromBreakaway: fv('winnerFromBreakaway'),
    gapRange: fv('gapRange'), winnerTeam: fv('winnerTeam'), mostCombative: fv('mostCombative'),
    winnerTime: fv('winnerTime'), lastClimbFirst: fv('lastClimbFirst'), greenChanged: fv('greenChanged')
  };
  try {
    await rpc('save_stage_prediction', { p_token: session.token, p_stage_id: stageId, p_data: data });
    myStages[stageId] = data; db.stagePredictions[session.id + '_' + stageId] = data;
    showToast('Pronostic enregistré !', 'success');
    // rafraîchir les marqueurs de statut + la liste déroulante
    const st = document.getElementById('spStatus'); if (st) st.innerHTML = spStatusHTML();
    const opt = document.querySelector(`#spStage option[value="${stageId}"]`);
    if (opt && !/✅/.test(opt.textContent)) opt.textContent = opt.textContent.replace(/🟢$/, '✅');
  } catch (err) { showToast(err.message, 'error'); }
}

// ================================================================
// ONGLET : CLASSEMENT
// ================================================================
function renderRanking(el) {
  const scores = {}; db.players.forEach(p => scores[p.id] = calculatePlayerTotal(p.id));
  const sorted = [...db.players].sort((a, b) => scores[b.id].total - scores[a.id].total);
  const stagesDone = db.stages.filter(s => db.stageResults[s.id]);

  let html = `<div class="section-title" style="margin-bottom:16px">🏆 Classement général</div>`;
  if (!sorted.length) { el.innerHTML = html + `<div class="empty-state"><p>Aucun joueur</p></div>`; return; }

  html += `<div class="card" style="overflow-x:auto"><table><thead><tr><th style="width:36px">#</th><th>Joueur</th><th style="text-align:right">Avant départ</th>${stagesDone.map(s => `<th style="text-align:right">É${s.number}</th>`).join('')}<th style="text-align:right;font-size:14px">Total</th></tr></thead><tbody>`;
  sorted.forEach((p, i) => {
    const sc = scores[p.id];
    const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const me = session && p.id === session.id;
    html += `<tr style="${me ? 'background:rgba(255,215,0,0.06)' : ''}"><td class="rank-pos ${medal}">${i + 1}</td><td class="rank-name">${esc(p.name)}${me ? ' <span class="badge badge-yellow">moi</span>' : ''}${!p.approved ? ' <span class="badge badge-muted">en attente</span>' : ''}</td><td style="text-align:right;color:var(--muted)">${sc.preTourPts || 0}</td>${stagesDone.map(s => `<td style="text-align:right;color:var(--muted)">${sc.stageBreakdown[s.id] || 0}</td>`).join('')}<td class="rank-pts">${sc.total}</td></tr>`;
  });
  html += `</tbody></table></div>`;
  html += `<p style="font-size:12px;color:var(--muted);margin-top:8px">En cas d'égalité, les joueurs restent ex æquo (règlement).</p>`;
  el.innerHTML = html;
}

// ================================================================
// ONGLET : DÉTAIL DES SCORES
// ================================================================
const PRE_TOUR_FIELDS = [
  ['winner', 'Vainqueur final', 100, 'rider'], ['podium', 'Podium final', 90, 'podium'],
  ['top10', 'Top 10 final', 100, 'top10'], ['greenJersey', 'Maillot vert', 50, 'rider'],
  ['polkaDotJersey', 'Maillot à pois', 50, 'rider'], ['whiteJersey', 'Maillot blanc', 40, 'rider'],
  ['bestTeam', 'Meilleure équipe', 30, 'team'], ['superCombative', 'Super combatif', 30, 'rider'],
  ['mostStageWinsRider', 'Coureur + victoires', 30, 'rider'], ['mostStageWinsTeam', 'Équipe + victoires', 30, 'team'],
  ['belgianWins', 'Victoires belges', 20, 'num'], ['abandonCount', 'Total abandons', 20, 'num'],
  ['finalGap', 'Avance vainqueur', 20, 'range']
];

function renderScoreDetail(el) {
  let html = `<div class="section-title" style="margin-bottom:16px">📊 Détail des scores</div>
    <div class="form-group" style="max-width:300px"><label>Joueur</label><select id="sdPlayer" onchange="renderScoreDetailContent()"><option value="">— Choisir —</option>
    ${db.players.map(p => `<option value="${p.id}" ${session && p.id === session.id ? 'selected' : ''}>${esc(p.name)}${session && p.id === session.id ? ' (moi)' : ''}</option>`).join('')}
    </select></div><div id="sdContent"></div>`;
  el.innerHTML = html;
  if (session) renderScoreDetailContent();
}

function renderScoreDetailContent() {
  const pid = document.getElementById('sdPlayer').value;
  const area = document.getElementById('sdContent');
  if (!pid) { area.innerHTML = ''; return; }
  const sc = calculatePlayerTotal(pid);
  const pred = db.pretourPredictions[pid];
  const res = db.pretourResults;
  let html = `<div style="font-size:18px;font-weight:700;color:var(--yellow);margin:8px 0 16px">Total : ${sc.total} pts</div>`;

  html += `<div class="card"><div class="card-title">Avant le départ · ${sc.preTourPts || 0} pts</div>`;
  if (!pred) html += `<div style="color:var(--muted)">${isPreTourLocked() ? 'Aucun pronostic encodé' : 'Pronostics non visibles tant que le Tour n\'a pas commencé'}</div>`;
  else {
    const sr = res ? calculatePreTourScore(pred, res) : null;
    PRE_TOUR_FIELDS.forEach(([key, label, max, type]) => {
      let pv = '—', rv = '—', pts = null;
      if (type === 'podium') { pv = (pred.podium || []).map(getRiderName).join(', '); rv = res ? (res.podium || []).map(getRiderName).join(', ') : '—'; pts = sr ? sr.detail.podium : null; }
      else if (type === 'top10') { pv = (pred.top10 || []).map(getRiderName).join(', '); rv = res ? (res.top10 || []).map(getRiderName).join(', ') : '—'; pts = sr ? sr.detail.top10 : null; }
      else if (type === 'rider') { pv = getRiderName(pred[key]); rv = res ? getRiderName(res[key]) : '—'; pts = sr ? sr.detail[key] : null; }
      else if (type === 'team') { pv = getTeamName(pred[key]); rv = res ? getTeamName(res[key]) : '—'; pts = sr ? sr.detail[key] : null; }
      else if (type === 'range') { pv = pred.finalGapRange || '—'; rv = res ? (res.finalGapRange || '—') : '—'; pts = sr ? sr.detail.finalGap : null; }
      else { pv = pred[key] != null && pred[key] !== '' ? pred[key] : '—'; rv = res ? (res[key] != null ? res[key] : '—') : '—'; pts = sr ? sr.detail[key] : null; }
      const cls = pts == null ? '' : pts === max ? 'perfect' : pts > 0 ? '' : 'zero';
      html += scoreRow(label, pv, rv, pts, max, cls);
    });
  }
  html += `</div>`;

  for (const stage of db.stages) {
    const sp = db.stagePredictions[pid + '_' + stage.id];
    const srr = db.stageResults[stage.id];
    const pts = sc.stageBreakdown[stage.id] || 0;
    const ti = STAGE_TYPES[stage.type] || STAGE_TYPES.plaine;
    html += `<div class="card"><div class="card-title">Étape ${stage.number} — ${esc(stage.title)} · ${pts} pts <span style="font-weight:400;font-size:11px">(×${ti.coefficient.toFixed(2)})</span></div>`;
    if (!sp) html += `<div style="color:var(--muted)">${isStageLocked(stage) ? 'Aucun pronostic' : 'Non visible (étape pas encore courue)'}</div>`;
    else if (!srr) html += `<div style="color:var(--muted)">En attente du résultat officiel</div>`;
    else {
      const { raw, detail } = calculateStageRawScore(sp, srr, stage);
      const F = [
        ['winner', 'Vainqueur', 25, getRiderName(sp.stageWinner), getRiderName(srr.winner)],
        ['top3', 'Top 3', 20, (sp.stageTop3 || []).map(getRiderName).join(', '), (srr.top3 || []).map(getRiderName).join(', ')],
        ['yellowJersey', 'Maillot jaune après', 10, getRiderName(sp.yellowJerseyAfter), getRiderName(srr.yellowJerseyAfter)],
        ['yellowChanged', 'Jaune change ?', 5, sp.yellowChanged, srr.yellowChanged],
        ['fromBreakaway', 'Échappée ?', 5, sp.winnerFromBreakaway, srr.winnerFromBreakaway],
        ['gapRange', 'Écart 1er/2e', 5, sp.gapRange, srr.gapRange],
        ['winnerTeam', 'Équipe vainqueur', 5, getTeamName(sp.winnerTeam), getTeamName(srr.winnerTeam)],
        ['mostCombative', 'Plus combatif', 5, getRiderName(sp.mostCombative), getRiderName(srr.mostCombative)],
        ['winnerTime', 'Temps vainqueur', 5, sp.winnerTime, srr.winnerTime]
      ];
      if (stage.type !== 'clm') F.splice(2, 0, ['finishType', "Type d'arrivée", 10, sp.finishType, srr.finishType]);
      if (stage.enableLastClimbPrediction) F.push(['lastClimb', 'Sommet dernière ascension', 5, getRiderName(sp.lastClimbFirst), getRiderName(srr.lastClimbFirst)]);
      if (stage.enableGreenJerseyChangePrediction) F.push(['greenChanged', 'Vert change ?', 5, sp.greenChanged, srr.greenChanged]);
      F.forEach(([k, label, max, pv, rv]) => {
        const p = detail[k] != null ? detail[k] : null;
        const cls = p == null ? '' : p === max ? 'perfect' : p > 0 ? '' : 'zero';
        html += scoreRow(label, pv, rv, p, max, cls);
      });
      html += `<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px;text-align:right">Brut ${raw} × ${ti.coefficient.toFixed(2)} = <strong style="color:var(--yellow)">${pts} pts</strong></div>`;
    }
    html += `</div>`;
  }
  area.innerHTML = html;
}
function scoreRow(label, pv, rv, pts, max, cls) {
  return `<div class="score-row"><div><div class="score-field">${label}</div><div style="font-size:12px;color:var(--muted)">Prono : <span style="color:var(--text)">${esc(String(pv || '—'))}</span> · Officiel : <span>${esc(String(rv || '—'))}</span></div></div><div class="score-pts ${cls}">${pts != null ? pts + ' / ' + max : '—'}</div></div>`;
}

// ================================================================
// ONGLET : COUREURS (lecture + édition organisateur)
// ================================================================
function renderRiders(el) {
  let html = `<div class="sub-tabs">
    <button class="sub-tab-btn active" id="stTeams" onclick="switchRiderTab('teams')">Équipes (${db.teams.length})</button>
    <button class="sub-tab-btn" id="stRiders" onclick="switchRiderTab('riders')">Coureurs (${db.riders.length})</button>
  </div><div id="ridersSub"></div>`;
  el.innerHTML = html; renderTeamsTab();
}
function switchRiderTab(t) {
  document.getElementById('stTeams').classList.toggle('active', t === 'teams');
  document.getElementById('stRiders').classList.toggle('active', t === 'riders');
  t === 'teams' ? renderTeamsTab() : renderRidersTab();
}
function renderTeamsTab() {
  const sc = document.getElementById('ridersSub');
  let html = '';
  if (orgaCode) html += `<div class="inline-form"><div class="inline-form-title">Ajouter une équipe</div><div class="form-row"><div class="form-group"><label>Nom</label><input type="text" id="ntName" maxlength="60"></div><button class="btn btn-primary" onclick="orgaAddTeam()">Ajouter</button></div></div>`;
  const ts = [...db.teams].sort((a, b) => a.name.localeCompare(b.name));
  html += `<div class="alert alert-info" style="margin-bottom:10px">Clique sur une équipe pour voir son effectif (leader ⭐, statut, maillots).</div>`;
  html += `<div class="card"><table><thead><tr><th>Équipe</th><th>Coureurs</th><th>Abandons</th>${orgaCode ? '<th></th>' : ''}</tr></thead><tbody>`;
  ts.forEach(t => {
    const team = db.riders.filter(r => r.teamId === t.id);
    const n = team.length;
    const out = team.filter(r => r.active === false).length;
    html += `<tr style="cursor:pointer" onclick="renderTeamDetail('${t.id}')"><td><strong style="color:var(--yellow)">${esc(t.name)} ›</strong></td><td><span class="badge badge-blue">${n}</span></td><td>${out ? `<span class="badge badge-red">${out}</span>` : '<span style="color:var(--muted)">—</span>'}</td>${orgaCode ? `<td class="td-actions" onclick="event.stopPropagation()">${n === 0 ? `<button class="btn btn-sm btn-danger" onclick="orgaDelTeam('${t.id}')">🗑️</button>` : ''}</td>` : ''}</tr>`;
  });
  html += `</tbody></table></div>`;
  sc.innerHTML = html;
}
function renderTeamDetail(teamId) {
  const sc = document.getElementById('ridersSub');
  if (!sc) return;
  const team = db.teams.find(t => t.id === teamId);
  if (!team) { renderTeamsTab(); return; }
  const j = currentJerseys();
  const riders = db.riders.filter(r => r.teamId === teamId).sort((a, b) => {
    const al = team.leader_id === a.id, bl = team.leader_id === b.id;
    if (al !== bl) return al ? -1 : 1;
    return byLastName(a, b);
  });

  let html = `<button class="btn btn-sm btn-outline" onclick="switchRiderTab('teams')">← Toutes les équipes</button>`;
  html += `<div class="card" style="margin-top:12px"><div class="card-title">${esc(team.name)} · ${riders.length} coureurs</div>`;
  html += `<div style="font-size:11px;color:var(--muted);margin-bottom:10px">Maillots : 🟡 jaune · 🟢 vert · 🔴 à pois · ⚪ blanc · ⭐ leader</div>`;
  if (!riders.length) html += `<div style="color:var(--muted)">Aucun coureur</div>`;
  else {
    html += `<table><tbody>`;
    riders.forEach(r => {
      const out = r.active === false;
      const isLeader = team.leader_id === r.id;
      html += `<tr style="${out ? 'opacity:.6' : ''}">
        <td>${isLeader ? '⭐ ' : ''}<strong style="${out ? 'color:var(--red)' : ''}">${esc(riderDisplay(r.name))}</strong>${r.nationality ? ` <span style="color:var(--muted);font-size:11px">${esc(r.nationality)}</span>` : ''}${riderJerseyBadges(r.id, j)} ${out ? '<span class="badge badge-red">ABANDON</span>' : '<span class="badge badge-green">actif</span>'}${isLeader ? ' <span class="badge badge-yellow">Leader</span>' : ''}</td>
        ${orgaCode ? `<td class="td-actions">${isLeader ? `<button class="btn btn-sm btn-outline" onclick="orgaSetLeader('${teamId}','')">retirer ⭐</button>` : `<button class="btn btn-sm btn-outline" onclick="orgaSetLeader('${teamId}','${r.id}')">⭐ Leader</button>`} <button class="btn btn-sm btn-outline" onclick="orgaToggleRider('${r.id}',${out},'${teamId}')">${out ? '✅' : '⛔'}</button></td>` : ''}
      </tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `</div>`;
  sc.innerHTML = html;
}

async function orgaSetLeader(teamId, riderId) {
  try {
    await rpc('admin_set_team_leader', { p_code: orgaCode, p_team_id: teamId, p_rider_id: riderId });
    await reloadRef();
    renderTeamDetail(teamId);
    showToast(riderId ? 'Leader défini ⭐' : 'Leader retiré', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

function renderRidersTab() {
  const sc = document.getElementById('ridersSub');
  const teams = [...db.teams].sort((a, b) => a.name.localeCompare(b.name));
  let html = '';
  if (orgaCode) html += `<div class="inline-form"><div class="inline-form-title">Ajouter un coureur</div><div class="grid-2" style="gap:8px;margin-bottom:8px"><div class="form-group"><label>Nom</label><input type="text" id="nrName" maxlength="60"></div><div class="form-group"><label>Nationalité</label><input type="text" id="nrNat" maxlength="10"></div><div class="form-group"><label>Équipe</label><select id="nrTeam"><option value="">— Sans équipe —</option>${teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div></div><button class="btn btn-primary" onclick="orgaAddRider()">Ajouter</button></div>`;
  const rs = [...db.riders].sort(byLastName);
  html += `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Coureur</th><th>Nat.</th><th>Équipe</th>${orgaCode ? '<th></th>' : ''}</tr></thead><tbody>`;
  rs.forEach(r => {
    const out = r.active === false;
    html += `<tr style="${out ? 'opacity:.65' : ''}"><td><strong style="${out ? 'color:var(--red)' : ''}">${esc(riderDisplay(r.name))}</strong>${out ? ' <span class="badge badge-red">ABANDON</span>' : ''}</td><td style="color:var(--muted)">${esc(r.nationality || '—')}</td><td>${esc(getTeamName(r.teamId))}</td>${orgaCode ? `<td class="td-actions"><button class="btn btn-sm btn-outline" onclick="orgaToggleRider('${r.id}',${out})">${out ? '✅ Réactiver' : '⛔ HS'}</button> <button class="btn btn-sm btn-danger" onclick="orgaDelRider('${r.id}')">🗑️</button></td>` : ''}</tr>`;
  });
  html += `</tbody></table></div>`;
  sc.innerHTML = html;
}
async function orgaAddTeam() {
  const name = document.getElementById('ntName').value.trim(); if (!name) return;
  try { await rpc('admin_upsert_team', { p_code: orgaCode, p_id: '', p_name: name }); await reloadRef(); renderTeamsTab(); showToast('Équipe ajoutée', 'success'); } catch (e) { showToast(e.message, 'error'); }
}
async function orgaDelTeam(id) { if (!confirm('Supprimer cette équipe ?')) return; try { await rpc('admin_delete_team', { p_code: orgaCode, p_id: id }); await reloadRef(); renderTeamsTab(); showToast('Supprimée', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function orgaAddRider() {
  const name = document.getElementById('nrName').value.trim(); if (!name) return;
  const nat = document.getElementById('nrNat').value.trim().toUpperCase(); const team = document.getElementById('nrTeam').value;
  try { await rpc('admin_upsert_rider', { p_code: orgaCode, p_id: '', p_name: name, p_nat: nat, p_team_id: team }); await reloadRef(); renderRidersTab(); showToast('Coureur ajouté', 'success'); } catch (e) { showToast(e.message, 'error'); }
}
async function orgaDelRider(id) { if (!confirm('Supprimer ce coureur ?')) return; try { await rpc('admin_delete_rider', { p_code: orgaCode, p_id: id }); await reloadRef(); renderRidersTab(); showToast('Supprimé', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function orgaToggleRider(id, currentlyOut, teamId) {
  try {
    await rpc('admin_set_rider_active', { p_code: orgaCode, p_rider_id: id, p_active: currentlyOut });
    await reloadRef();
    if (teamId) renderTeamDetail(teamId); else renderRidersTab();
    showToast(currentlyOut ? 'Coureur réactivé' : 'Coureur marqué abandon', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
async function reloadRef() {
  const [teams, riders] = await Promise.all([sbSelect('teams'), sbSelect('riders')]);
  db.teams = teams; db.riders = riders.map(r => ({ id: r.id, name: r.name, nationality: r.nationality, teamId: r.team_id, active: r.active !== false }));
}

// ================================================================
// ONGLET : ÉTAPES (lecture + édition organisateur)
// ================================================================
function renderStages(el) {
  let html = `<div class="section-header"><div class="section-title">📅 Étapes</div>${orgaCode ? `<button class="btn btn-primary" onclick="orgaStageModal()">+ Ajouter</button>` : ''}</div>`;
  html += `<div class="alert alert-info" style="margin-bottom:10px">Clique sur une étape pour voir sa fiche (distance, dénivelé, cols & sprints, profil officiel).</div>`;
  db.stages.forEach(s => {
    const ti = STAGE_TYPES[s.type] || STAGE_TYPES.plaine; const locked = isStageLocked(s);
    html += `<div class="stage-card" style="cursor:pointer" onclick="renderStageDetail('${s.id}')"><div class="stage-num" style="background:${locked ? '#2a1515' : 'var(--surface)'}">É${s.number}</div><div class="stage-info"><div class="stage-title">${esc(s.title)} ›</div><div class="stage-meta">${formatDate(s.date)} · ${shortTime(s.startTime)} · <span class="${ti.color}">${ti.label}</span>${s.distanceKm ? ' · ' + s.distanceKm + ' km' : ''} · <span class="coeff-badge">×${ti.coefficient.toFixed(2)}</span>${s.enableLastClimbPrediction ? ' · ⛰️' : ''}${s.enableGreenJerseyChangePrediction ? ' · 🟢' : ''}</div></div><div class="stage-actions" onclick="event.stopPropagation()"><span class="badge ${locked ? 'badge-locked' : 'badge-open'}">${locked ? '🔒' : '🟢'}</span>${orgaCode ? `<button class="btn btn-sm btn-outline" onclick="orgaStageModal('${s.id}')">✏️</button>` : ''}</div></div>`;
  });
  el.innerHTML = html;
}

const PT_ICON = { col: '⛰️', sprint: '🏁', depart: '🚩', arrivee: '🏆', cote: '↗️', ravito: '🥤' };

// Profil d'altitude « maison » (SVG original, dessiné depuis profile_points [{km,alt,type,name,cat}])
function elevationSVG(points) {
  const pts = (points || []).filter(p => p && p.km != null && p.alt != null).sort((a, b) => a.km - b.km);
  if (pts.length < 2) return '';
  const W = 800, H = 274, padL = 40, padR = 14, padT = 54, padB = 46;
  const kmMin = pts[0].km, kmMax = pts[pts.length - 1].km;
  const alts = pts.map(p => p.alt);
  let aMin = Math.min(...alts), aMax = Math.max(...alts);
  const aPad = (aMax - aMin) * 0.18 || 50; aMin = Math.max(0, Math.floor((aMin - aPad) / 50) * 50); aMax = Math.ceil((aMax + aPad) / 50) * 50;
  const x = km => padL + ((km - kmMin) / (kmMax - kmMin || 1)) * (W - padL - padR);
  const y = al => padT + (1 - (al - aMin) / (aMax - aMin || 1)) * (H - padT - padB);
  const baseY = y(aMin);
  const linePts = pts.map(p => `${x(p.km).toFixed(1)},${y(p.alt).toFixed(1)}`).join(' ');
  const area = `${padL.toFixed(1)},${baseY.toFixed(1)} ${linePts} ${x(kmMax).toFixed(1)},${baseY.toFixed(1)}`;

  const COL = { sprint: '#2ecc71', col: '#E8373A', arrivee: '#FFD700', depart: '#888' };
  let dots = '', labels = '';
  const rowRight = [];          // x occupé le plus à droite pour chaque niveau d'étiquette
  pts.forEach(p => {
    if (!p.type || p.type === 'pt') return;
    const px = x(p.km), py = y(p.alt), c = COL[p.type] || '#888';
    dots += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="${c}"/>`;
    if (!p.name) return;
    const lbl = (p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name) + (p.cat ? ' (' + p.cat + ')' : '');
    // ancrage adapté pour ne pas déborder aux extrémités
    let anchor = 'middle', tx = px;
    if (px < padL + 45) { anchor = 'start'; tx = px - 4; }
    else if (px > W - padR - 45) { anchor = 'end'; tx = px + 4; }
    // intervalle horizontal occupé par le texte (approx)
    const w = lbl.length * 5.6;
    const left = anchor === 'middle' ? tx - w / 2 : anchor === 'end' ? tx - w : tx;
    const right = left + w;
    // choisit le niveau le plus bas où l'étiquette ne chevauche pas la précédente
    let lvl = 0;
    while (rowRight[lvl] != null && left < rowRight[lvl] + 6) lvl++;
    rowRight[lvl] = right;
    const labelY = Math.max(9, py - 10 - lvl * 12);
    // trait de liaison du point vers l'étiquette si elle est remontée
    if (lvl > 0) labels += `<line x1="${px.toFixed(1)}" y1="${(py - 4).toFixed(1)}" x2="${px.toFixed(1)}" y2="${(labelY + 2).toFixed(1)}" stroke="#555" stroke-width="0.7"/>`;
    labels += `<text x="${tx.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="9.5" fill="#ddd" text-anchor="${anchor}">${esc(lbl)}</text>`;
  });
  const marks = dots + labels;
  // graduations altitude (min/max)
  const grid = `
    <line x1="${padL}" y1="${y(aMax).toFixed(1)}" x2="${W - padR}" y2="${y(aMax).toFixed(1)}" stroke="#333" stroke-dasharray="3 3"/>
    <line x1="${padL}" y1="${baseY.toFixed(1)}" x2="${W - padR}" y2="${baseY.toFixed(1)}" stroke="#333"/>
    <text x="4" y="${(y(aMax) + 3).toFixed(1)}" font-size="9" fill="#888">${aMax} m</text>
    <text x="4" y="${(baseY + 3).toFixed(1)}" font-size="9" fill="#888">${aMin} m</text>`;

  // axe kilométrique sous la ligne de base : balise km de chaque difficulté + guide pointillé
  let kmAxis = `<rect x="${padL}" y="${baseY.toFixed(1)}" width="${(W - padR - padL).toFixed(1)}" height="${(H - baseY).toFixed(1)}" fill="#0d0d0d"/>`;
  const kmRowRight = [];
  pts.forEach(p => {
    if (!p.type || p.type === 'pt') return;
    const px = x(p.km), py = y(p.alt);
    kmAxis += `<line x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${px.toFixed(1)}" y2="${baseY.toFixed(1)}" stroke="#444" stroke-width="0.7" stroke-dasharray="2 2"/>`;
    const txt = '' + p.km;
    const w = txt.length * 5.2;
    let anchor = 'middle', tx = px;
    if (px < padL + 12) { anchor = 'start'; tx = padL; }
    else if (px > W - padR - 12) { anchor = 'end'; tx = W - padR; }
    const left = anchor === 'middle' ? tx - w / 2 : anchor === 'end' ? tx - w : tx;
    let lvl = 0; while (kmRowRight[lvl] != null && left < kmRowRight[lvl] + 4) lvl++; if (lvl > 2) lvl = 2;
    kmRowRight[lvl] = left + w;
    const ky = baseY + 12 + lvl * 10;
    kmAxis += `<text x="${tx.toFixed(1)}" y="${ky.toFixed(1)}" font-size="8.5" fill="#e8c84a" text-anchor="${anchor}">${esc(txt)}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;background:#141414;border:1px solid var(--border);border-radius:6px;margin-bottom:12px" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD70055"/><stop offset="1" stop-color="#FFD70008"/></linearGradient></defs>
    ${grid}
    <polygon points="${area}" fill="url(#elevGrad)"/>
    <polyline points="${linePts}" fill="none" stroke="#FFD700" stroke-width="2" stroke-linejoin="round"/>
    ${kmAxis}
    ${marks}
  </svg>`;
}
function renderStageDetail(stageId) {
  const el = document.getElementById('mainContent');
  const s = db.stages.find(x => x.id === stageId);
  if (!s) { showTab('stages'); return; }
  const ti = STAGE_TYPES[s.type] || STAGE_TYPES.plaine;
  const locked = isStageLocked(s);
  const res = db.stageResults[s.id];

  let html = `<button class="btn btn-sm btn-outline" onclick="showTab('stages')">← Toutes les étapes</button>`;
  html += `<div class="card" style="margin-top:12px"><div class="card-title">Étape ${s.number} · ${esc(s.title)}</div>`;
  html += `<div class="stats-row" style="margin-bottom:8px">
    <div class="stat-box"><div class="stat-label">Type</div><div class="stat-value ${ti.color}" style="font-size:16px">${ti.label}</div></div>
    <div class="stat-box"><div class="stat-label">Distance</div><div class="stat-value" style="font-size:16px">${s.distanceKm ? s.distanceKm + ' km' : '—'}</div></div>
    <div class="stat-box"><div class="stat-label">Dénivelé</div><div class="stat-value" style="font-size:16px">${s.elevationM ? s.elevationM + ' m' : '—'}</div></div>
    <div class="stat-box"><div class="stat-label">Coefficient</div><div class="stat-value" style="font-size:16px">×${ti.coefficient.toFixed(2)}</div></div>
  </div>`;
  html += `<div style="color:var(--muted);font-size:13px">📅 ${formatDate(s.date)} · départ ${shortTime(s.startTime)} · ${locked ? '🔒 verrouillée' : '🟢 ouverte aux pronos'}${s.enableLastClimbPrediction ? ' · ⛰️ prono sommet actif' : ''}${s.enableGreenJerseyChangePrediction ? ' · 🟢 prono maillot vert actif' : ''}</div>`;
  html += `</div>`;

  // Points clés (cols, sprints…)
  html += `<div class="card"><div class="card-title">🗺️ Parcours & passages clés</div>`;
  const svg = elevationSVG(s.profilePoints);
  if (svg) html += svg;
  const pts = Array.isArray(s.details) ? [...s.details].sort((a, b) => (a.km || 0) - (b.km || 0)) : [];
  if (!pts.length) {
    html += `<div style="color:var(--muted);font-size:13px">Détail du parcours pas encore renseigné pour cette étape.</div>`;
  } else {
    html += `<table><tbody>`;
    pts.forEach(p => {
      const icon = PT_ICON[p.type] || '•';
      const label = p.type === 'col' ? `Col ${p.cat ? '(cat. ' + esc(p.cat) + ')' : ''}` : p.type === 'sprint' ? 'Sprint intermédiaire' : p.type === 'arrivee' ? 'Arrivée' : p.type === 'depart' ? 'Départ' : (p.type || '');
      html += `<tr><td style="width:60px;color:var(--muted)">${p.km != null ? 'km ' + p.km : ''}</td><td>${icon} <strong>${esc(p.name || '')}</strong>${p.alt ? ` <span style="color:var(--muted);font-size:11px">${esc(p.alt)} m</span>` : ''}</td><td style="color:var(--muted);font-size:12px;text-align:right">${label}</td></tr>`;
    });
    html += `</tbody></table>`;
  }
  html += `<div style="margin-top:12px"><a href="${esc(s.profileUrl || 'https://www.letour.fr/fr/le-parcours')}" target="_blank" rel="noopener" class="btn btn-sm btn-outline">📈 Voir le profil officiel sur letour.fr ↗</a></div>`;
  html += `</div>`;

  // Résultat si dispo
  if (res) {
    html += `<div class="card"><div class="card-title">✅ Résultat</div>
      <div class="score-row"><div class="score-field">Vainqueur</div><div><strong>${esc(getRiderName(res.winner))}</strong></div></div>
      ${res.top3 ? `<div class="score-row"><div class="score-field">Top 3</div><div>${(res.top3 || []).map(getRiderName).join(', ')}</div></div>` : ''}
      ${res.yellowJerseyAfter ? `<div class="score-row"><div class="score-field">Maillot jaune</div><div>🟡 ${esc(getRiderName(res.yellowJerseyAfter))}</div></div>` : ''}
    </div>`;
  }

  el.innerHTML = html;
}
function orgaStageModal(id) {
  const s = id ? db.stages.find(x => x.id === id) : { number: '', date: '', startTime: '13:00', title: '', type: 'plaine', enableLastClimbPrediction: false, enableGreenJerseyChangePrediction: false };
  showModal(`<div class="inline-form-title" style="margin-bottom:12px">${id ? 'Modifier' : 'Ajouter'} une étape</div>
    <div class="grid-2" style="gap:8px"><div class="form-group"><label>Numéro</label><input type="number" id="stgNum" value="${esc(s.number)}" min="1" max="21"></div><div class="form-group"><label>Date</label><input type="date" id="stgDate" value="${esc(s.date)}"></div><div class="form-group"><label>Heure départ</label><input type="time" id="stgTime" value="${esc(shortTime(s.startTime))}"></div><div class="form-group"><label>Type</label><select id="stgType">${Object.entries(STAGE_TYPES).map(([k, v]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${v.label} (×${v.coefficient.toFixed(2)})</option>`).join('')}</select></div></div>
    <div class="form-group"><label>Titre</label><input type="text" id="stgTitle" value="${esc(s.title)}" maxlength="100"></div>
    <label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input type="checkbox" id="stgClimb" ${s.enableLastClimbPrediction ? 'checked' : ''}> ⛰️ Option sommet dernière ascension</label>
    <label style="display:flex;align-items:center;gap:6px;margin:6px 0"><input type="checkbox" id="stgGreen" ${s.enableGreenJerseyChangePrediction ? 'checked' : ''}> 🟢 Option maillot vert change</label>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-primary" onclick="orgaSaveStage('${id || ''}')">Enregistrer</button><button class="btn btn-outline" onclick="closeModal()">Annuler</button></div>`);
}
async function orgaSaveStage(id) {
  const num = parseInt(document.getElementById('stgNum').value);
  const date = document.getElementById('stgDate').value, time = document.getElementById('stgTime').value;
  const type = document.getElementById('stgType').value, title = document.getElementById('stgTitle').value.trim();
  if (!num || !date || !title || !time) return showToast('Champs obligatoires manquants', 'error');
  try {
    await rpc('admin_upsert_stage', { p_code: orgaCode, p_id: id, p_number: num, p_date: date, p_start_time: time, p_title: title, p_type: type, p_coefficient: STAGE_TYPES[type].coefficient, p_last_climb: document.getElementById('stgClimb').checked, p_green: document.getElementById('stgGreen').checked });
    const stages = await sbSelect('stages', 'select=*&order=number.asc');
    db.stages = stages.map(s => ({ id: s.id, number: s.number, date: s.date, startTime: s.start_time, title: s.title, type: s.type, coefficient: Number(s.coefficient), enableLastClimbPrediction: s.enable_last_climb, enableGreenJerseyChangePrediction: s.enable_green_jersey, lockUntil: s.lock_until }));
    closeModal(); showTab('stages'); showToast('Étape enregistrée', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// ================================================================
// ONGLET : RÈGLEMENT
// ================================================================
function renderRules(el) {
  el.innerHTML = `<div class="section-title" style="margin-bottom:16px">📜 Règlement</div>
  <div class="card"><div class="card-title">Principe</div><p>Jeu privé entre amis, gratuit, sans mise ni enjeu financier. Chaque joueur pronostique avant le départ puis chaque étape. Le classement est calculé selon le barème ci-dessous.</p></div>
  <div class="card"><div class="card-title">Verrouillage</div><p>Les pronostics avant départ sont verrouillés au départ de l'étape 1. Chaque étape est verrouillée à son heure de départ. Après verrouillage, plus aucune modification possible.</p></div>
  <div class="card"><div class="card-title">Barème avant le départ — 610 pts max</div><table><tbody>
    <tr><td>Vainqueur final</td><td class="rank-pts">100</td></tr><tr><td>Podium (90/60/35/15)</td><td class="rank-pts">90</td></tr><tr><td>Top 10 (10/coureur)</td><td class="rank-pts">100</td></tr><tr><td>Maillot vert</td><td class="rank-pts">50</td></tr><tr><td>Maillot à pois</td><td class="rank-pts">50</td></tr><tr><td>Maillot blanc</td><td class="rank-pts">40</td></tr><tr><td>Meilleure équipe</td><td class="rank-pts">30</td></tr><tr><td>Super combatif</td><td class="rank-pts">30</td></tr><tr><td>Coureur + victoires d'étapes</td><td class="rank-pts">30</td></tr><tr><td>Équipe + victoires d'étapes</td><td class="rank-pts">30</td></tr><tr><td>Victoires belges</td><td class="rank-pts">20</td></tr><tr><td>Total abandons</td><td class="rank-pts">20</td></tr><tr><td>Avance vainqueur (20 / voisine 10)</td><td class="rank-pts">20</td></tr>
  </tbody></table></div>
  <div class="card"><div class="card-title">Barème par étape — 105 pts max × coefficient</div><table><tbody>
    <tr><td>Vainqueur</td><td class="rank-pts">25</td></tr><tr><td>Top 3 (20/15/10/5)</td><td class="rank-pts">20</td></tr><tr><td>Type d'arrivée <span style="color:var(--muted)">(sauf contre-la-montre)</span></td><td class="rank-pts">10</td></tr><tr><td>Maillot jaune après l'étape</td><td class="rank-pts">10</td></tr><tr><td>Maillot jaune change ?</td><td class="rank-pts">5</td></tr><tr><td>Vainqueur de l'échappée ?</td><td class="rank-pts">5</td></tr><tr><td>Écart 1er/2e</td><td class="rank-pts">5</td></tr><tr><td>Équipe du vainqueur</td><td class="rank-pts">5</td></tr><tr><td>Plus combatif</td><td class="rank-pts">5</td></tr><tr><td>Temps du vainqueur</td><td class="rank-pts">5</td></tr><tr><td>⛰️ Sommet dernière ascension (si actif)</td><td class="rank-pts">5</td></tr><tr><td>🟢 Maillot vert change (si actif)</td><td class="rank-pts">5</td></tr>
  </tbody></table></div>
  <div class="card"><div class="card-title">Coefficients</div><table><tbody><tr><td class="type-plaine">Plaine</td><td>×1,00</td></tr><tr><td class="type-accidentee">Accidentée</td><td>×1,15</td></tr><tr><td class="type-montagne">Montagne</td><td>×1,35</td></tr><tr><td class="type-clm">Contre-la-montre</td><td>×1,25</td></tr></tbody></table><p style="margin-top:8px;font-size:12px;color:var(--muted)">Appliqué au total de l'étape, arrondi au point entier.</p></div>
  <div class="card"><div class="card-title">Égalités</div><p>Les joueurs à égalité restent ex æquo. Le bonus coup de poker n'est pas activé dans cette version.</p></div>`;
}

// ================================================================
// ONGLET ORGA : INSCRIPTIONS
// ================================================================
async function renderRegistrations(el) {
  if (!orgaCode) { el.innerHTML = `<div class="alert alert-danger">Réservé à l'organisateur.</div>`; return; }
  el.innerHTML = `<div class="section-title" style="margin-bottom:16px">🛂 Validation des inscriptions</div><div id="regList"><div class="loading">Chargement…</div></div>`;
  try {
    const regs = await rpc('admin_list_registrations', { p_code: orgaCode });
    const pending = regs.filter(r => !r.approved), approved = regs.filter(r => r.approved);
    let html = '';
    html += `<div class="card"><div class="card-title">⏳ En attente (${pending.length})</div>`;
    if (!pending.length) html += `<div style="color:var(--muted)">Aucune demande en attente</div>`;
    else { html += `<table><tbody>`; pending.forEach(r => { html += `<tr><td><strong>${esc(r.name)}</strong><div style="font-size:12px;color:var(--muted)">${esc(r.email || 'pas d\'email')}</div>${r.note ? `<div style="font-size:12px;color:var(--text);margin-top:4px;padding:6px 8px;background:var(--surface);border-left:2px solid var(--yellow);border-radius:3px">💬 ${esc(r.note)}</div>` : ''}</td><td class="td-actions"><button class="btn btn-sm btn-primary" onclick="orgaApprove('${r.id}')">✅ Valider</button> <button class="btn btn-sm btn-danger" onclick="orgaReject('${r.id}')">🗑️</button></td></tr>`; }); html += `</tbody></table>`; }
    html += `</div>`;
    html += `<div class="card"><div class="card-title">✅ Validés (${approved.length})</div>`;
    if (!approved.length) html += `<div style="color:var(--muted)">Aucun joueur validé</div>`;
    else { html += `<table><tbody>`; approved.forEach(r => { html += `<tr><td><strong>${esc(r.name)}</strong><div style="font-size:12px;color:var(--muted)">${esc(r.email || '')}</div></td><td class="td-actions"><button class="btn btn-sm btn-outline" onclick="orgaResetPass('${r.id}','${esc(r.name)}')">🔑</button> <button class="btn btn-sm btn-outline" onclick="orgaRevoke('${r.id}')">⏸️</button> <button class="btn btn-sm btn-danger" onclick="orgaReject('${r.id}')">🗑️</button></td></tr>`; }); html += `</tbody></table>`; }
    html += `</div>`;
    document.getElementById('regList').innerHTML = html;
  } catch (e) { document.getElementById('regList').innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`; }
}
async function orgaApprove(id) { try { await rpc('admin_set_approval', { p_code: orgaCode, p_player_id: id, p_approve: true }); await reloadPlayers(); showTab('registrations'); showToast('Validé !', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function orgaRevoke(id) { if (!confirm('Suspendre ce joueur ?')) return; try { await rpc('admin_set_approval', { p_code: orgaCode, p_player_id: id, p_approve: false }); await reloadPlayers(); showTab('registrations'); showToast('Suspendu', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function orgaReject(id) { if (!confirm('Supprimer définitivement ce compte ?')) return; try { await rpc('admin_delete_player', { p_code: orgaCode, p_player_id: id }); await reloadPlayers(); showTab('registrations'); showToast('Supprimé', 'success'); } catch (e) { showToast(e.message, 'error'); } }
async function orgaResetPass(id, name) {
  const np = prompt('Nouveau mot de passe pour ' + name + ' :'); if (!np) return;
  try { await rpc('admin_reset_password', { p_code: orgaCode, p_player_id: id, p_newpass: np }); showToast('Mot de passe réinitialisé', 'success'); } catch (e) { showToast(e.message, 'error'); }
}
async function reloadPlayers() { db.players = await sbSelect('players', 'select=id,name,approved&order=created_at.asc'); }

// ================================================================
// ONGLET ORGA : RÉSULTATS
// ================================================================
function renderResults(el) {
  if (!orgaCode) { el.innerHTML = `<div class="alert alert-danger">Réservé à l'organisateur.</div>`; return; }
  el.innerHTML = `<div class="sub-tabs"><button class="sub-tab-btn active" id="rsPre" onclick="switchResultTab('pre')">Résultats finaux</button><button class="sub-tab-btn" id="rsStage" onclick="switchResultTab('stage')">Résultats par étape</button></div><div id="resContent"></div>`;
  renderPreResultForm();
}
function switchResultTab(t) {
  document.getElementById('rsPre').classList.toggle('active', t === 'pre');
  document.getElementById('rsStage').classList.toggle('active', t === 'stage');
  t === 'pre' ? renderPreResultForm() : renderStageResultPicker();
}
function renderPreResultForm() {
  const r = db.pretourResults || {};
  let html = `<div class="card"><div class="card-title">Résultats finaux du Tour</div><form id="prForm" onsubmit="saveOrgaPreResult(event)">
    <div class="pred-section"><div class="pred-section-title">🥇 Général</div>
      <div class="form-group"><label>Vainqueur</label>${riderSelect('winner', r.winner)}</div>
      <div class="form-group"><label>Podium 1er</label>${riderSelect('pod0', r.podium && r.podium[0])}</div>
      <div class="form-group"><label>Podium 2e</label>${riderSelect('pod1', r.podium && r.podium[1])}</div>
      <div class="form-group"><label>Podium 3e</label>${riderSelect('pod2', r.podium && r.podium[2])}</div></div>
    <div class="pred-section"><div class="pred-section-title">🔟 Top 10</div>`;
  for (let i = 0; i < 10; i++) html += `<div class="form-group"><label>n°${i + 1}</label>${riderSelect('top10_' + i, r.top10 && r.top10[i])}</div>`;
  html += `</div><div class="pred-section"><div class="pred-section-title">🎽 Maillots</div>
      <div class="form-group"><label>Vert</label>${riderSelect('greenJersey', r.greenJersey)}</div>
      <div class="form-group"><label>Pois</label>${riderSelect('polkaDotJersey', r.polkaDotJersey)}</div>
      <div class="form-group"><label>Blanc</label>${riderSelect('whiteJersey', r.whiteJersey)}</div></div>
    <div class="pred-section"><div class="pred-section-title">🏆 Équipes & Prix</div>
      <div class="form-group"><label>Meilleure équipe</label>${teamSelect('bestTeam', r.bestTeam)}</div>
      <div class="form-group"><label>Super combatif</label>${riderSelect('superCombative', r.superCombative)}</div>
      <div class="form-group"><label>Coureur + victoires</label>${riderSelect('mostStageWinsRider', r.mostStageWinsRider)}</div>
      <div class="form-group"><label>Équipe + victoires</label>${teamSelect('mostStageWinsTeam', r.mostStageWinsTeam)}</div></div>
    <div class="pred-section"><div class="pred-section-title">📊 Stats</div>
      <div class="form-group"><label>Victoires belges</label><input type="number" name="belgianWins" min="0" value="${r.belgianWins != null ? r.belgianWins : ''}"></div>
      <div class="form-group"><label>Abandons</label><input type="number" name="abandonCount" min="0" value="${r.abandonCount != null ? r.abandonCount : ''}"></div>
      <div class="form-group"><label>Avance vainqueur</label>${rangeSelect('finalGapRange', r.finalGapRange, FINAL_GAP_RANGES)}</div></div>
    <button type="submit" class="btn btn-primary">💾 Enregistrer & recalculer</button></form></div>`;
  document.getElementById('resContent').innerHTML = html;
}
async function saveOrgaPreResult(e) {
  e.preventDefault(); const f = e.target, fv = n => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
  const top10 = []; for (let i = 0; i < 10; i++) top10.push(fv('top10_' + i));
  const data = { winner: fv('winner'), podium: [fv('pod0'), fv('pod1'), fv('pod2')], top10, greenJersey: fv('greenJersey'), polkaDotJersey: fv('polkaDotJersey'), whiteJersey: fv('whiteJersey'), bestTeam: fv('bestTeam'), superCombative: fv('superCombative'), mostStageWinsRider: fv('mostStageWinsRider'), mostStageWinsTeam: fv('mostStageWinsTeam'), belgianWins: fv('belgianWins'), abandonCount: fv('abandonCount'), finalGapRange: fv('finalGapRange') };
  try { await rpc('admin_set_pretour_result', { p_code: orgaCode, p_data: data }); db.pretourResults = data; showToast('Résultats enregistrés !', 'success'); } catch (err) { showToast(err.message, 'error'); }
}
function renderStageResultPicker() {
  let html = `<div class="form-group" style="max-width:420px"><label>Étape</label><select id="resStage" onchange="renderStageResultForm()"><option value="">— Choisir —</option>${db.stages.map(s => `<option value="${s.id}">[É${s.number}] ${esc(s.title)}${db.stageResults[s.id] ? ' ✅' : ''}</option>`).join('')}</select></div><div id="resStageArea"></div>`;
  document.getElementById('resContent').innerHTML = html;
}
function renderStageResultForm() {
  const id = document.getElementById('resStage').value; const area = document.getElementById('resStageArea');
  if (!id) { area.innerHTML = ''; return; }
  const stage = db.stages.find(s => s.id === id); const r = db.stageResults[id] || {};
  let html = `<div class="card"><div class="card-title">Résultat — Étape ${stage.number} : ${esc(stage.title)}</div><form id="srForm" onsubmit="saveOrgaStageResult(event,'${id}')">
    <div class="pred-section"><div class="pred-section-title">🏁 Résultat</div>
      <div class="form-group"><label>Vainqueur</label>${riderSelect('winner', r.winner, undefined, 'onchange="onStageWinnerChange(this)"')}</div>
      <div class="form-group"><label>Top 3 — 1er</label>${riderSelect('top3_0', r.top3 && r.top3[0])}</div>
      <div class="form-group"><label>Top 3 — 2e</label>${riderSelect('top3_1', r.top3 && r.top3[1])}</div>
      <div class="form-group"><label>Top 3 — 3e</label>${riderSelect('top3_2', r.top3 && r.top3[2])}</div>
      ${stage.type !== 'clm' ? `<div class="form-group"><label>Type d'arrivée</label><select name="finishType"><option value="">—</option>${FINISH_TYPES.map(t => `<option value="${esc(t)}" ${t === r.finishType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>` : ''}
      <div class="form-group"><label>Équipe vainqueur</label>${teamSelect('winnerTeam', r.winnerTeam)}</div></div>
    <div class="pred-section"><div class="pred-section-title">🟡 Maillot jaune</div>
      <div class="form-group"><label>Porteur après</label>${riderSelect('yellowJerseyAfter', r.yellowJerseyAfter)}</div>
      <div class="form-group"><label>Jaune change ?</label>${boolSelect('yellowChanged', r.yellowChanged)}</div></div>
    <div class="pred-section"><div class="pred-section-title">🎽 Maillots après l'étape <span style="font-weight:400;color:var(--muted)">(info, non noté)</span></div>
      <div class="form-group"><label>🟢 Maillot vert</label>${riderSelect('greenJerseyAfter', r.greenJerseyAfter)}</div>
      <div class="form-group"><label>🔴 Maillot à pois</label>${riderSelect('polkaJerseyAfter', r.polkaJerseyAfter)}</div>
      <div class="form-group"><label>⚪ Maillot blanc</label>${riderSelect('whiteJerseyAfter', r.whiteJerseyAfter)}</div></div>
    <div class="pred-section"><div class="pred-section-title">📊 Compléments</div>
      <div class="form-group"><label>Échappée ?</label>${boolSelect('winnerFromBreakaway', r.winnerFromBreakaway)}</div>
      <div class="form-group"><label>Écart 1er/2e</label>${rangeSelect('gapRange', r.gapRange, STAGE_GAP_RANGES)}</div>
      <div class="form-group"><label>Plus combatif</label>${riderSelect('mostCombative', r.mostCombative)}</div>
      <div class="form-group"><label>Temps vainqueur</label><input type="time" name="winnerTime" value="${esc(r.winnerTime || '')}"></div></div>`;
  if (stage.enableLastClimbPrediction) html += `<div class="pred-section"><div class="pred-section-title">⛰️ Sommet</div><div class="form-group"><label>Premier au sommet</label>${riderSelect('lastClimbFirst', r.lastClimbFirst)}</div></div>`;
  if (stage.enableGreenJerseyChangePrediction) html += `<div class="pred-section"><div class="pred-section-title">🟢 Vert</div><div class="form-group"><label>Vert change ?</label>${boolSelect('greenChanged', r.greenChanged)}</div></div>`;
  html += `<button type="submit" class="btn btn-primary">💾 Enregistrer & recalculer</button> ${db.stageResults[id] ? `<button type="button" class="btn btn-danger" onclick="delOrgaStageResult('${id}')">🗑️ Effacer</button>` : ''}</form></div>`;
  area.innerHTML = html;
}
async function saveOrgaStageResult(e, id) {
  e.preventDefault(); const f = e.target, fv = n => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
  const data = { winner: fv('winner'), top3: [fv('top3_0'), fv('top3_1'), fv('top3_2')], finishType: fv('finishType'), winnerTeam: fv('winnerTeam'), yellowJerseyAfter: fv('yellowJerseyAfter'), yellowChanged: fv('yellowChanged'), winnerFromBreakaway: fv('winnerFromBreakaway'), gapRange: fv('gapRange'), mostCombative: fv('mostCombative'), winnerTime: fv('winnerTime'), lastClimbFirst: fv('lastClimbFirst'), greenChanged: fv('greenChanged'), greenJerseyAfter: fv('greenJerseyAfter'), polkaJerseyAfter: fv('polkaJerseyAfter'), whiteJerseyAfter: fv('whiteJerseyAfter') };
  try { await rpc('admin_set_stage_result', { p_code: orgaCode, p_stage_id: id, p_data: data }); db.stageResults[id] = data; showToast('Résultat enregistré !', 'success'); } catch (err) { showToast(err.message, 'error'); }
}
async function delOrgaStageResult(id) {
  if (!confirm('Effacer le résultat de cette étape ?')) return;
  try { await rpc('admin_delete_stage_result', { p_code: orgaCode, p_stage_id: id }); delete db.stageResults[id]; renderStageResultForm(); showToast('Résultat effacé', 'success'); } catch (e) { showToast(e.message, 'error'); }
}

// ================================================================
// INIT
// ================================================================
async function init() {
  loadSession();
  await refreshWhoami();
  try {
    await loadAll();
  } catch (e) {
    document.getElementById('mainContent').innerHTML = `<div class="alert alert-danger">Erreur de connexion à la base : ${esc(e.message)}</div>`;
    return;
  }
  renderShell();
  showTab('dashboard');

  // Expose pour onclick inline
  Object.assign(window, {
    showTab, openAuth, doRegister, doLogin, logout, toggleOrga, closeModal,
    renderPronos, showPronosSub, goPronos, resetPreTour, resetStage,
    savePreTour, renderStageForm, saveStage, onStageWinnerChange, onPreTourWinnerChange, selectStage,
    renderScoreDetailContent, switchRiderTab,
    orgaAddTeam, orgaDelTeam, orgaAddRider, orgaDelRider, orgaToggleRider,
    renderTeamDetail, orgaSetLeader, renderStageDetail,
    orgaStageModal, orgaSaveStage,
    switchResultTab, renderStageResultForm, saveOrgaPreResult, saveOrgaStageResult, delOrgaStageResult,
    orgaApprove, orgaRevoke, orgaReject, orgaResetPass
  });
}
window.addEventListener('DOMContentLoaded', init);
