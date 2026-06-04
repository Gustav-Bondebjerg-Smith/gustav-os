# Design-handoff: Gustav OS dashboard

Til brug i Claude Design (claude.ai). Sådan gør du:
1. Ny chat på claude.ai. Indsæt hele "BRIEF"-blokken nedenfor.
2. Bed om varianter: "vis retning A og B", "gør accenten varmere", "mere kompakt", "prøv lys baggrund".
3. Når du er glad: send mig HTML'en (eller artifact'en). Jeg porter den ind i appen.

Strukturen fra Modul 1 (kort-komponent, grid, token-fil) er allerede klar til at modtage et nyt look, så det er hurtigt at skifte. Kun token-værdier og kort-stil ændres. Dit arbejde i Claude Design går ikke tabt.

---

## BRIEF (kopier alt herunder ind i Claude Design)

Du skal designe forsiden af mit personlige "operating system": et dashboard jeg åbner hver dag for at se hele mit liv på ét skærmbillede. Lav en single-page HTML mockup. Brug de ægte placeholder-data nedenfor, ikke lorem ipsum.

### Hvem det er til
Gustav, 23, medicinstuderende på SDU der også arbejder som sygeplejevikar og forskningsassistent. Dashboardet skal føles roligt at kigge på dagligt, men gøre dårlige forbrugsvaner svære at ignorere.

### Skærmens opbygning
Topbar:
- Venstre: brand "gustav/os" (monospace).
- Faner: I dag, Opgaver, Mål, Finans, Balance, Captures, Ask. "I dag" er aktiv.
- Højre kant: dato + tid.

Under topbar: et responsivt kort-grid. 3 kolonner på desktop, 2 på tablet, 1 på mobil. Kortene:

1. Dagens opgaver (de 3 vigtigste i dag)
   - Læs farmakologi kap. 7 (interaktioner). I DAG, vigtig.
   - Send timeseddel til Herlev. I DAG.
   - Book studiegruppe-lokale. Denne uge.
2. I dag (kalender, resten af dagen)
   - 08:00-12:00 Forelæsning: Farmakologi
   - 14:00-15:00 Studiegruppe
   - 16:30-22:00 SPV-vagt, Herlev
3. Finans (vigtigst, skal fange øjet)
   - Nettoformue: 48.250 kr. Dagligt sving +120 kr. Månedligt sving +1.840 kr.
   - "Syndeudgifter denne måned": Takeaway 640 kr, Sodavand 180 kr, Spil 200 kr. Vis dem så de er svære at ignorere (fx rød/advarsel-farve).
4. Mål
   - Denne uge: Træn 3x, Aflever metode-afsnit.
   - Denne måned: Spar 2.000 kr, Læs 2 fagbøger færdig.
5. Venter på dig (forslag fra assistenten med veto-vindue)
   - Tandlæge tirsdag 10:00. Veto 6 min.
6. Seneste captures (hurtige noter)
   - voice: "Husk at spørge vejleder om datasæt"
   - tekst: "Idé: app der minder om vagter"

### Stil, leg med disse retninger (lav gerne flere varianter)
- A) Mørk cockpit: næsten-sort, glasmorfisme, én neon-agtig accent, monospace til tal.
- B) Lys skandinavisk: off-white, masser af luft, én rolig accent (salvie/ler), bløde skygger.
- C) Terminal/brutalist: høj kontrast, monospace overalt, skarpe hjørner, minimal farve.
- D) Notion-agtig: lys grå, runde hjørner, blød og venlig, indhold først.

Gennemgående: tal er altid monospace. Tal med fortegn (sving, syndeudgifter) farves, grøn op, rød ned/synd.

### Krav til output (så det kan bygges ind bagefter)
- Én selvstændig HTML-fil.
- Læg ALLE farver, afstande, radius og fonts som CSS-variabler i toppen (fx --color-bg, --color-accent, --color-ink-1, --radius-card, --font-sans, --font-mono). Så kan de mappes direkte ind i en Tailwind-opsætning.
- Plain HTML + CSS (Tailwind via CDN er også ok). Intet build-værktøj.
- Responsivt grid som beskrevet. Dansk tekst. Ingen rigtige billeder nødvendige.

Start med din stærkeste fortolkning. Bagefter beder jeg dig justere (lysere, anden accent, mere kompakt osv.).
