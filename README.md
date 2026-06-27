# 🚴 Pronostics Tour 2026

Application web de pronostics du **Tour de France 2026** — jeu privé entre amis, gratuit, sans mise ni enjeu financier.

**App en ligne :** https://z0rkismin3.github.io/tour-de-france-2026/

Application multi-utilisateurs : chaque participant crée son compte, se connecte depuis son propre appareil et encode ses pronostics. Les données sont stockées en ligne (Supabase). Le classement est partagé et mis à jour en direct.

## Fonctionnement

### Pour les participants
1. **Créer un compte** (pseudo + mot de passe, email facultatif).
2. L'inscription est **validée par l'organisateur** avant de pouvoir pronostiquer (lecture libre en attendant).
3. Encoder ses **pronostics avant le départ** (verrouillés au départ de l'étape 1) et ses **pronostics par étape** (verrouillés à l'heure de départ de chaque étape).
4. Suivre le **classement** et le **détail des points**.

### Pour l'organisateur
Cliquer sur **🔑** (en haut à droite) et saisir le code organisateur. Onglets supplémentaires :
- **🛂 Joueurs** : valider / suspendre / supprimer les inscriptions, réinitialiser un mot de passe.
- **✅ Résultats** : encoder les résultats finaux et ceux de chaque étape. Les scores sont recalculés automatiquement.
- Gestion des **coureurs / équipes / étapes** depuis les onglets correspondants.

## Architecture technique

- **Frontend** : HTML / CSS / JavaScript vanilla, hébergé sur GitHub Pages.
- **Backend** : Supabase (PostgreSQL).
  - Authentification par jeton de session (mot de passe haché bcrypt).
  - Tables : `players`, `player_auth` (privée), `teams`, `riders`, `stages`, `pretour_predictions`, `stage_predictions`, `pretour_results`, `stage_results`, `settings`.
  - **Sécurité** : RLS activée partout. Toutes les écritures passent par des fonctions `SECURITY DEFINER` qui vérifient le jeton et l'approbation. Les pronostics des autres joueurs ne sont **lisibles qu'une fois l'étape verrouillée** (anti-triche).
  - Verrouillage des pronostics **côté serveur** (impossible de pronostiquer après le départ).

## Barème

### Avant le départ — 610 pts max
Vainqueur 100 · Podium 90 (90/60/35/15) · Top 10 100 (10/coureur) · Maillot vert 50 · à pois 50 · blanc 40 · Meilleure équipe 30 · Super combatif 30 · Coureur + victoires 30 · Équipe + victoires 30 · Victoires belges 20 · Abandons 20 · Avance vainqueur 20 (voisine 10).

### Par étape — 110 pts max × coefficient
Vainqueur 25 · Top 3 20 (20/15/10/5) · Type d'arrivée 10 · Maillot jaune après 10 · Jaune change 5 · Échappée 5 · Écart 1er/2e 5 · Équipe vainqueur 5 · Plus combatif 5 · Garde le jaune 5 · Temps vainqueur 5 · Sommet dernière ascension 5 (si actif) · Maillot vert change 5 (si actif).

**Coefficients :** Plaine ×1,00 · Accidentée ×1,15 · Montagne ×1,35 · Contre-la-montre ×1,25. Arrondi au point entier.

En cas d'égalité, les joueurs restent ex æquo. Le bonus coup de poker n'est pas activé dans cette version.

## Développement local

Servir le dossier en statique (l'app appelle directement Supabase) :

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

> Pas de logo officiel du Tour de France. Application non officielle, sans affiliation.
