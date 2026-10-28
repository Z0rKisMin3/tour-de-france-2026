# Analyse de documents

Application HTML / CSS / JavaScript qui analyse un document et produit une version structurée et facile à lire. **Tout le traitement se fait en local, dans le navigateur. Aucune donnée n'est envoyée sur le réseau.**

## Utilisation

1. Ouvrir `index.html` dans un navigateur récent (Chrome, Edge, Firefox ou Safari) : un double-clic suffit, sans serveur ni installation, et ça fonctionne hors ligne.
2. Déposer un fichier (`.docx`, `.odt`, `.txt`, `.md`, `.html`) ou coller un texte.
3. Lire le document structuré produit, puis l'exporter en **HTML**, en **Markdown** ou l'**imprimer / l'enregistrer en PDF**.
4. Cliquer sur « Tout effacer » (ou fermer l'onglet) pour retirer les données de la mémoire.

## Ce que produit l'analyse

| Partie | Contenu |
| --- | --- |
| En-tête | Titre, source, nombre de mots, temps de lecture, nombre de sections, indice de lisibilité |
| En bref | Synthèse extractive : les phrases les plus représentatives, dans l'ordre du document |
| Mots-clés | Termes et expressions les plus fréquents |
| Sommaire | Plan cliquable des sections |
| Points d'attention | Phrases contenant une obligation, un délai ou une action (« doit », « avant le », « s'engage »…) |
| Données repérées | Dates, montants, pourcentages, e-mails, téléphones, liens, avec leur contexte et leur section |
| Contenu structuré | Le texte réorganisé par sections (titres, paragraphes, listes, tableaux), avec un résumé d'une phrase pour les sections longues |

Un texte sans titres est découpé automatiquement en parties, nommées d'après leurs mots dominants.

## Confidentialité

- Aucune bibliothèque externe, aucun CDN, aucune police web : tous les fichiers sont dans ce dossier.
- Une politique de sécurité (`Content-Security-Policy`, dans `index.html`) interdit toute connexion réseau (`connect-src 'none'`, pas d'images, de polices ni de formulaires distants). Même en cas de bug, la page ne peut rien envoyer.
- Les fichiers sont lus avec `FileReader` / `DOMParser`, qui n'exécutent aucun script et ne chargent aucune ressource.
- Le contenu du document est toujours inséré comme texte, jamais interprété comme du HTML.
- Le fichier HTML exporté contient la même protection et s'ouvre lui aussi hors ligne.

## Limites

- **PDF** : non pris en charge pour l'instant. Copiez le texte du PDF et collez-le dans la zone de texte.
- **.doc** (ancien format Word) : enregistrez-le d'abord en `.docx`.
- La synthèse est **extractive** (phrases reprises du texte, sans IA) : elle aide à lire vite mais ne remplace pas la lecture des passages importants.

## Structure

```
index.html      interface
styles.css      styles de l'interface
js/zip.js       lecture des archives .docx / .odt (décompression native du navigateur)
js/parsers.js   conversion des formats en blocs (titres, paragraphes, listes, tableaux)
js/analyzer.js  sections, synthèse, mots-clés, données repérées, statistiques
js/render.js    document structuré, export HTML et Markdown
js/app.js       interactions
```
