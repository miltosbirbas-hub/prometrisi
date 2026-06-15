# Προμέτρηση — Μπετόν & Οπλισμός ανά Στάθμη

PWA για προμέτρηση σκυροδέματος και οπλισμού από σχέδια (DXF/PDF) και αυτόματη
ανάγνωση στατικού τεύχους (Fespa). Vanilla JS, χωρίς build step.

## Deploy σε GitHub Pages

1. Φτιάξε νέο repo (π.χ. `prometrisi`) στο GitHub.
2. Ανέβασε ΟΛΑ τα αρχεία στο root του repo:
   ```
   index.html
   app.js
   sw.js
   manifest.webmanifest
   .nojekyll
   icons/icon-192.png
   icons/icon-512.png
   icons/icon-maskable-512.png
   ```
3. Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / `/ (root)` → Save.
4. Σε ~1 λεπτό: `https://<username>.github.io/prometrisi/`

## Σημαντικά

- **Απαιτείται HTTPS** για να δουλέψει ο service worker — το GitHub Pages το παρέχει αυτόματα.
- **PWA caching**: app shell = cache-first (offline), CDN libs = network-first.
  Σε κάθε νέο deploy, ΑΛΛΑΞΕ το `CACHE_VERSION` στο `sw.js` (π.χ. v1.0.0 → v1.0.1)
  αλλιώς οι χρήστες θα βλέπουν παλιά έκδοση.
- **CDN libs**: pdf.js, dxf-parser, SheetJS, jsPDF φορτώνουν από cdnjs. Θέλει internet
  την πρώτη φορά· μετά cachάρονται για offline χρήση.
- Τα DXF/PDF επεξεργάζονται **τοπικά** στον browser — δεν ανεβαίνουν πουθενά.

## Custom domain (προαιρετικά)

Όπως στο terrain.birbas.gr: πρόσθεσε αρχείο `CNAME` με το domain, και στον Papaki
βάλε CNAME record προς `<username>.github.io`.
