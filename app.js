/* ========= Προμέτρηση — app logic ========= */
if (typeof pdfjsLib !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

const $ = s => document.querySelector(s);
const fmt = (n,d=2)=> (n==null||isNaN(n))?"—":Number(n).toLocaleString("el-GR",{minimumFractionDigits:d,maximumFractionDigits:d});

function toast(msg,err){const t=$("#toast");t.textContent=msg;t.className="toast show"+(err?" err":"");
  clearTimeout(t._t);t._t=setTimeout(()=>t.className="toast",2600);}

/* ---------- State ---------- */
const state = {
  files: [],          // {id,name,kind,raw,dxf?,pdfDoc?,level,units,layerRoles:{}}
  activeId: null,
  results: null,
  study: null,        // parsed στατικό τεύχος {grade,steel,levels:[],total:{}}
  beton: [   // study assumptions — roles
    {role:"ΠΛΑΚΑ",       type:"area",  thick:0.18, kg:120, color:"#d98c2b"},
    {role:"ΥΠΟΣΤΥΛΩΜΑΤΑ", type:"area",  thick:3.00, kg:180, color:"#c0631e"},
    {role:"ΔΟΚΟΙ",       type:"area",  thick:0.60, kg:150, color:"#e0a050"},
    {role:"ΤΟΙΧΙΟ",      type:"area",  thick:3.00, kg:90,  color:"#a8551a"},
    {role:"ΘΕΜΕΛΙΩΣΗ",   type:"area",  thick:0.80, kg:100, color:"#8a6d3b"},
  ],
  rebar: [   // diameter -> kg/m  (πφ²/4 * 7850)
    {dia:"Φ8",  kgm:0.395, key:"8"},
    {dia:"Φ10", kgm:0.617, key:"10"},
    {dia:"Φ12", kgm:0.888, key:"12"},
    {dia:"Φ14", kgm:1.208, key:"14"},
    {dia:"Φ16", kgm:1.578, key:"16"},
    {dia:"Φ20", kgm:2.466, key:"20"},
  ],
  // Απώλειες σκυροδέτησης (ζούμι/πρέσες) ανά στάθμη
  pumpWaste: 0.75,        // m³ που κρατάει κάθε πρέσα (ζούμι)
  defaultLoad: 8,         // ενδεικτικό m³/πρέσα για αυτόματη εκτίμηση πλήθους πρεσών
  levelCasting: {},       // { levelName: {pumps:Number, mode:"mono"|"kostoumi"} }
  // Πίνακας κοπής οπλισμού
  barLength: 12,          // μήκος εμπορικής ράβδου (m)
  cutAssume: {            // παραδοχές για εκτίμηση μηκών από DXF labels
    storeyHeight: 3.00,   // καθαρό ύψος ορόφου (m) — μήκος διαμήκων κολώνας
    lap: 0.60,            // μάτιση/αναμονή ανά ράβδο κολώνας (m)
    cover: 0.05,          // επικάλυψη (m) για υπολογισμό συνδετήρα
    hook: 0.10,           // μήκος γάντζου συνδετήρα (m) ανά άκρο
  },
};
const ROLES = ["—","ΠΛΑΚΑ","ΥΠΟΣΤΥΛΩΜΑΤΑ","ΔΟΚΟΙ","ΤΟΙΧΙΟ","ΘΕΜΕΛΙΩΣΗ","ΟΠΛΙΣΜΟΣ","ΙΣΟΥΨΕΙΣ","ΑΓΝΟΗΣΗ"];

const uid = ()=>Math.random().toString(36).slice(2,9);

/* ---------- Geometry helpers ---------- */
function polyPoints(e){
  // returns array of {x,y} from LWPOLYLINE / POLYLINE
  if(e.vertices) return e.vertices.map(v=>({x:v.x,y:v.y}));
  return [];
}
function shoelace(pts){
  let a=0;for(let i=0;i<pts.length;i++){const p=pts[i],q=pts[(i+1)%pts.length];a+=p.x*q.y-q.x*p.y;}
  return Math.abs(a)/2;
}
function polyLen(pts,closed){
  let L=0;const n=pts.length;const lim=closed?n:n-1;
  for(let i=0;i<lim;i++){const p=pts[i],q=pts[(i+1)%n];L+=Math.hypot(q.x-p.x,q.y-p.y);}
  return L;
}
function entityLength(e){
  if(e.type==="LINE"&&e.vertices) {const[a,b]=e.vertices;return Math.hypot(b.x-a.x,b.y-a.y);}
  if((e.type==="LWPOLYLINE"||e.type==="POLYLINE")){const p=polyPoints(e);return polyLen(p,!!e.shape||!!e.closed);}
  if(e.type==="ARC"){const ang=Math.abs((e.endAngle-e.startAngle));return Math.abs(e.radius*ang);}
  if(e.type==="CIRCLE") return 2*Math.PI*e.radius;
  return 0;
}
function isClosedPoly(e){
  if(e.type==="CIRCLE") return true;
  if(e.type!=="LWPOLYLINE"&&e.type!=="POLYLINE") return false;
  if(e.shape===true||e.closed===true) return true;
  const p=polyPoints(e); if(p.length<3) return false;
  const a=p[0],b=p[p.length-1];
  return Math.hypot(a.x-b.x,a.y-b.y) < 1e-6 * (Math.abs(a.x)+Math.abs(a.y)+1);
}
function entityArea(e){
  if(e.type==="CIRCLE") return Math.PI*e.radius*e.radius;
  return shoelace(polyPoints(e));
}

/* ---------- Ανάγνωση labels οπλισμού από TEXT/MTEXT ---------- */
// Επιστρέφει κείμενο όλων των TEXT/MTEXT ενός DXF
function collectTexts(dxf){
  const out=[];
  (dxf.entities||[]).forEach(e=>{
    if((e.type==="TEXT"||e.type==="MTEXT") && e.text){
      // καθάρισμα MTEXT formatting codes \A1; {\f...} κλπ
      let t=(""+e.text).replace(/\\[A-Za-z][^;]*;/g,"").replace(/[{}]/g,"").trim();
      if(t) out.push(t);
    }
  });
  return out;
}
// Parse ενός label. Τύποι:
//  διαμήκεις: "4Φ20+8Φ16", "5Φ12", "3Φ14 Α+Κ"
//  συνδετήρες/τσέρκια: "Σ Φ8/10", "ΣΦ10/10"  → Φ8 ανά 10cm
//  πλέγμα/εσχάρα: "Φ12/15", "#Φ10/20", "Φ10/15 Α"  → Φ12 ανά 15cm
function parseRebarLabel(raw){
  const t=raw.replace(/\s+/g,"").toUpperCase().replace(/FI/g,"Φ");
  const out={longit:[], stirrup:null, mesh:null};
  // Συνδετήρας/τσέρκι: περιέχει Σ (όχι #). Το # δηλώνει εσχάρα/πλέγμα.
  const isStirrup=/Σ/.test(t) && !/#/.test(t);
  const spacingMatch=t.match(/Φ(\d{1,2})\/(\d{1,3})/);
  if(spacingMatch){
    const dia="Φ"+spacingMatch[1], step=parseInt(spacingMatch[2])/100; // cm→m
    if(isStirrup) out.stirrup={dia, step};
    else out.mesh={dia, step};
    return out;
  }
  // Διαμήκεις: nΦd (+ nΦd)...
  const re=/(\d+)Φ(\d{1,2})/g; let m;
  while((m=re.exec(t))){ out.longit.push({count:parseInt(m[1]), dia:"Φ"+m[2]}); }
  return (out.longit.length||out.stirrup||out.mesh)?out:null;
}
// Χτίζει αναλυτικό πίνακα κοπής από τα labels των DXF (εκτιμώμενα μήκη)
function buildCutFromDxf(){
  const A=state.cutAssume;
  const items=[]; // {source, dia, count, lenEach, type}
  state.files.filter(f=>f.kind==="dxf").forEach(f=>{
    const texts=collectTexts(f.dxf);
    // βρες διαστάσεις διατομών (π.χ. "40/40","100/25") — ΟΧΙ βήματα οπλισμού (Φ8/10)
    const dims=texts.map(t=>{
      // αφαίρεσε πρώτα τυχόν Φn/n ώστε να μη μπερδευτεί με διάσταση
      const clean=t.replace(/Φ\s*\d{1,2}\s*\/\s*\d{1,3}/gi,"");
      const m=clean.match(/\b(\d{2,3})\/(\d{2,3})\b/);
      return m?{a:+m[1]/100,b:+m[2]/100}:null;
    }).filter(Boolean);
    const avgDim = dims.length ? {a:dims.reduce((s,d)=>s+d.a,0)/dims.length, b:dims.reduce((s,d)=>s+d.b,0)/dims.length} : {a:0.40,b:0.40};
    texts.forEach(t=>{
      const p=parseRebarLabel(t); if(!p) return;
      // διαμήκεις → μήκος = ύψος ορόφου + μάτιση
      p.longit.forEach(L=>{
        items.push({source:f.level||f.name, dia:L.dia, count:L.count,
          lenEach:+(A.storeyHeight+A.lap).toFixed(2), type:"διαμήκης"});
      });
      // συνδετήρας → πλήθος = ύψος/βήμα, μήκος = περίμετρος διατομής - επικαλύψεις + γάντζοι
      if(p.stirrup){
        const a=avgDim.a, b=avgDim.b;
        const perim = 2*((a-2*A.cover)+(b-2*A.cover)) + 2*A.hook;
        const n = Math.ceil(A.storeyHeight/p.stirrup.step)+1;
        items.push({source:f.level||f.name, dia:p.stirrup.dia, count:n,
          lenEach:+perim.toFixed(2), type:"συνδετήρας"});
      }
      // εσχάρα/πλέγμα → δύσκολο χωρίς επιφάνεια· καταγράφεται ως σημείωση
      // (παραλείπεται από αυτόματο υπολογισμό μήκους)
    });
  });
  // συγκεντρωτικά ανά διάμετρο
  const byDia={};
  items.forEach(it=>{
    if(!byDia[it.dia]) byDia[it.dia]={dia:it.dia, totLen:0, count:0};
    byDia[it.dia].totLen += it.count*it.lenEach;
    byDia[it.dia].count  += it.count;
  });
  return {items, byDia};
}
// Βάρος ανά μέτρο για διάμετρο (από state.rebar ή τύπο 0.00617·d²)
function kgPerM(dia){
  const r=state.rebar.find(x=>x.dia===dia);
  if(r) return r.kgm;
  const n=parseInt(dia.replace(/\D/g,""))||0;
  return +(n*n*0.00617).toFixed(3);
}

/* ---------- File handling ---------- */
let parser = null;
function getParser(){
  if(parser) return parser;
  if(typeof DxfParser==="undefined"){
    toast("Η βιβλιοθήκη DXF δεν φόρτωσε — έλεγξε τη σύνδεση και κάνε ανανέωση.",true);
    return null;
  }
  parser = new DxfParser();
  return parser;
}

// Τρεις ζώνες: DXF ξυλοτύπου, PDF τεύχους, PDF προβολής
function wireZone(inputId, zoneSel, kindHint){
  const inp=$("#"+inputId), zone=document.querySelector(zoneSel);
  if(!inp||!zone) return;
  inp.addEventListener("change",e=>{ handleFiles(e.target.files, kindHint); e.target.value=""; });
  ["dragover","dragenter"].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add("hot");}));
  ["dragleave"].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove("hot");}));
  zone.addEventListener("drop",e=>{e.preventDefault();zone.classList.remove("hot");handleFiles(e.dataTransfer.files,kindHint);});
}
wireZone("fileDxf",  ".zdxf",  "dxf");
wireZone("filePdf",  ".zpdf",  "teuxos");
wireZone("fileView", ".zview", "view");

async function handleFiles(list, kindHint){
  for(const f of list){
    const ext=f.name.split(".").pop().toLowerCase();
    // έλεγχος ότι το αρχείο ταιριάζει με τη ζώνη
    if(kindHint==="dxf" && ext!=="dxf"){ toast(`Η ζώνη 1 δέχεται μόνο DXF — το «${f.name}» δεν είναι DXF.`,true); continue; }
    if((kindHint==="teuxos"||kindHint==="view") && ext!=="pdf"){ toast(`Η ζώνη δέχεται μόνο PDF — το «${f.name}» δεν είναι PDF.`,true); continue; }

    if(ext==="dxf"){
      const txt=await f.text();
      let dxf;
      const P=getParser(); if(!P) continue;
      try{ dxf=P.parseSync(txt); }
      catch(err){ toast("Σφάλμα ανάγνωσης DXF: "+f.name,true); console.error(err); continue; }
      const layers=collectLayers(dxf);
      const roles={};
      layers.forEach(l=>roles[l.name]=guessRole(l.name));
      state.files.push({id:uid(),name:f.name,kind:"dxf",role:"ξυλότυπος",dxf,layers,
        level:guessLevel(f.name),units:1,layerRoles:roles});
      toast(`✓ DXF «${f.name}» — αντιστοίχισε layers & πάτησε «Υπολογισμός».`);
    } else if(ext==="pdf"){
      const buf=await f.arrayBuffer();
      let doc; try{ doc=await pdfjsLib.getDocument({data:buf.slice(0)}).promise; }
      catch(err){ toast("Σφάλμα PDF: "+f.name,true); continue; }
      const fileObj={id:uid(),name:f.name,kind:"pdf",
        role: kindHint==="view"?"προβολή":"τεύχος",
        pdfDoc:doc,page:1,scale:1.3};
      state.files.push(fileObj);

      if(kindHint==="view"){
        // Ζώνη 3: μόνο προβολή — δεν επιχειρείται ανάγνωση τεύχους
        toast(`«${f.name}» προστέθηκε για προβολή.`);
      } else {
        // Ζώνη 2: προσπάθεια ανάγνωσης ως τεύχος προμέτρησης (όλα τα ελληνικά στατικά προγράμματα)
        try{
          const fullText=await extractPdfText(doc);
          const parsed=parseStudy(fullText);
          if(parsed){ parsed.fileName=f.name; state.study=parsed;
            const tot = parsed.total ? fmt(parsed.total.concrete) : "—";
            toast(`✓ Τεύχος: ${parsed.levels.length} στάθμες, ${tot} m³`);
            renderResults();
            const rt=document.querySelector('.tab[data-view="results"]'); if(rt) rt.click();
          } else {
            toast(`«${f.name}»: δεν αναγνωρίστηκε ως τεύχος προμέτρησης — προβάλλεται μόνο. (Για προβολή χρησιμοποίησε τη ζώνη 3.)`,true);
          }
        }catch(err){ console.warn("study parse failed",err);
          toast("Δεν διαβάστηκε ως τεύχος — προβάλλεται μόνο.",true); }
      }
    } else { toast("Μη υποστηριζόμενο: "+f.name,true); continue; }
  }
  renderFiles();
  if(state.files.length && !state.activeId) setActive(state.files[state.files.length-1].id);
  refreshCalcBtn();
}

function collectLayers(dxf){
  const m={};
  (dxf.entities||[]).forEach(e=>{
    const ln=e.layer||"0";
    if(!m[ln]) m[ln]={name:ln,count:0,closed:0,open:0};
    m[ln].count++;
    if(isClosedPoly(e)) m[ln].closed++; else m[ln].open++;
  });
  return Object.values(m).sort((a,b)=>b.count-a.count);
}
function guessRole(name){
  const u=name.toUpperCase();
  if(/ΠΛΑΚ|SLAB|PLAK/.test(u)) return "ΠΛΑΚΑ";
  if(/ΥΠΟΣΤ|COL|STIL|ΚΟΛ/.test(u)) return "ΥΠΟΣΤΥΛΩΜΑΤΑ";
  if(/ΔΟΚ|BEAM|DOK/.test(u)) return "ΔΟΚΟΙ";
  if(/ΤΟΙΧ|WALL|TIX/.test(u)) return "ΤΟΙΧΙΟ";
  if(/ΘΕΜΕΛ|FOOT|FOUND|PEDIL|ΠΕΔΙΛ/.test(u)) return "ΘΕΜΕΛΙΩΣΗ";
  if(/ΟΠΛ|REBAR|STEEL|ΣΙΔ|Φ\d|FI\d/.test(u)) return "ΟΠΛΙΣΜΟΣ";
  if(/ΙΣΟΥΨ|CONTOUR|ΥΨΟΜ/.test(u)) return "ΙΣΟΥΨΕΙΣ";
  return "—";
}
function guessLevel(fn){
  const u=fn.toUpperCase();
  if(/ΥΠΟΓ|BASE|B1|-1/.test(u)) return "Υπόγειο";
  if(/ΙΣΟΓ|GROUND|ISOG/.test(u)) return "Ισόγειο";
  if(/Α.?ΟΡΟΦ|1ST|FLOOR.?1/.test(u)) return "Α' Όροφος";
  if(/Β.?ΟΡΟΦ|2ND/.test(u)) return "Β' Όροφος";
  if(/ΘΕΜΕΛ|FOUND/.test(u)) return "Θεμελίωση";
  return fn.replace(/\.dxf$/i,"");
}

function renderFiles(){
  const c=$("#flist");
  if(!state.files.length){c.innerHTML='<div class="note">Κανένα αρχείο ακόμη.</div>';return;}
  c.innerHTML="";
  state.files.forEach(f=>{
    const d=document.createElement("div");
    d.className="fitem"+(f.id===state.activeId?" act":"");
    d.style.cursor="pointer";
    if(f.id===state.activeId) d.style.borderColor=f.kind==="dxf"?"var(--beton)":"var(--steel)";
    d.innerHTML=`<span class="ic ${f.kind}">${f.kind.toUpperCase()}</span>
      <span class="nm">${f.name}${f.role?` <span class="frole">${f.role}</span>`:""}</span>
      <button class="rm" title="Αφαίρεση">×</button>`;
    d.querySelector(".nm").onclick=()=>setActive(f.id);
    d.querySelector(".ic").onclick=()=>setActive(f.id);
    d.querySelector(".rm").onclick=ev=>{ev.stopPropagation();removeFile(f.id);};
    c.appendChild(d);
  });
}
function removeFile(id){
  state.files=state.files.filter(f=>f.id!==id);
  if(state.activeId===id) state.activeId=state.files[0]?.id||null;
  renderFiles();
  if(state.activeId) setActive(state.activeId); else clearViewer();
  refreshCalcBtn();
}
function clearViewer(){
  $("#vEmpty").style.display="grid";$("#dxfViewer").style.display="none";$("#pdfViewer").style.display="none";
  const s=$("#dxfSec"); if(s)s.style.display="none";
}

function setActive(id){
  state.activeId=id;
  const f=state.files.find(x=>x.id===id);
  renderFiles();
  $("#vEmpty").style.display="none";
  const dxfSec=$("#dxfSec");
  if(f.kind==="dxf"){
    $("#dxfViewer").style.display="flex";$("#pdfViewer").style.display="none";
    if(dxfSec) dxfSec.style.display="block";
    $("#lvlName").value=f.level;
    $("#vName").textContent=f.name;
    // πληροφορίες σχεδίου
    const nEnt=(f.dxf.entities||[]).length;
    const nTxt=(f.dxf.entities||[]).filter(e=>e.type==="TEXT"||e.type==="MTEXT").length;
    const info=$("#dxfInfo"); if(info) info.textContent=`${nEnt} entities · ${nTxt} κείμενα · ${f.layers.length} layers`;
    drawDXF(f);
  } else {
    $("#dxfViewer").style.display="none";$("#pdfViewer").style.display="flex";
    if(dxfSec) dxfSec.style.display="none";
    $("#pName").textContent=f.name;
    renderPDF(f);
  }
}

$("#lvlName").addEventListener("input",e=>{const f=cur();if(f)f.level=e.target.value;});
function cur(){return state.files.find(f=>f.id===state.activeId);}

/* ---------- Στατικό τεύχος: text extraction + parser ---------- */
async function extractPdfText(doc){
  let out="";
  const N=doc.numPages;
  for(let p=1;p<=N;p++){
    const page=await doc.getPage(p);
    const tc=await page.getTextContent();
    // group items into lines by y, then sort by x
    const lines={};
    tc.items.forEach(it=>{
      const y=Math.round(it.transform[5]);
      (lines[y]=lines[y]||[]).push({x:it.transform[4],s:it.str});
    });
    Object.keys(lines).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const row=lines[y].sort((a,b)=>a.x-b.x).map(o=>o.s).join(" ");
      out+=row+"\n";
    });
    out+="\f";
  }
  return out;
}

function gnum(s){ if(s==null) return 0; s=(""+s).trim(); if(!s||s==="-") return 0;
  return parseFloat(s.replace(/\./g,"").replace(/,/g,"."))||0; }

// Αναγνώριση & ανάγνωση τεύχους προμέτρησης από ελληνικά στατικά προγράμματα.
// Βασίζεται σε κοινές έννοιες (όγκος σκυροδέματος, βάρος οπλισμού, πίνακες Φ), όχι σε εταιρεία.
function parseStudy(txt){
  // Ανιχνευτής: χρειάζεται να μοιάζει με τεύχος προμέτρησης (όγκος σκυρ. + πίνακας Φ + στάθμες/σύνολο)
  const looksLikeStudy =
    /(προμέτρηση|προμετρηση|ποσότητ|ποσοτητ)/i.test(txt) &&
    /(σκυροδ|σκυρόδ)/i.test(txt) &&
    /Φ\s*\d{1,2}\s+[\d.,]+\s+[\d.,]+/.test(txt);
  if(!looksLikeStudy) return null;

  // Βρες αρχή ενότητας προμέτρησης (αν υπάρχει συγκεντρωτικός τίτλος), αλλιώς όλο το κείμενο
  const startMatch = txt.match(/(?:συνολική|συγκεντρωτικ|γενική)\s+προμέτρηση/i);
  const section = startMatch ? txt.slice(startMatch.index) : txt;

  // Υλικά (ανεκτικό σε μορφές)
  const gradeM = txt.match(/Σκυρόδεμα[:\s]*\s*(C\d+\/\d+)/i) || txt.match(/\bC(?:12|16|20|25|30|35|40|45|50)\/\d+\b/);
  const steelM = txt.match(/Χάλυβας[:\s]*\s*(B\d+\w*)/i) || txt.match(/\bB500[A-C]\b/);

  // Όρια μπλοκ: τα ΕΠΟΜΕΝΑ markers σταθμών ή το σύνολο κτιρίου (όχι κάθε "Προμέτρηση",
  // γιατί οι running headers σελίδων περιέχουν τη λέξη και κόβουν λάθος τα μπλοκ)
  const boundRe=/(?:σύνολο\s+(?:ορόφου|οροφου|στάθμη[ςσ]?|σταθμη[ςσ]?)\s*:?\s*-?\d+)|(?:σύνολο\s+κτιρίου|γενικό\s+σύνολο|σύνολο\s+έργου)/gi;
  const headers=[]; let hm; while((hm=boundRe.exec(section))) headers.push(hm.index);

  // Στάθμες: κυρίως "Σύνολο ορόφου :N" αλλά και παραλλαγές. Απαιτεί λέξη-κλειδί συνόλου/ορόφου + αριθμό.
  const levels=[];
  const lvlRe=/(?:σύνολο\s+(?:ορόφου|οροφου|στάθμη[ςσ]?|σταθμη[ςσ]?|επιπέδου|επιπεδου)|(?:ορόφου|οροφου|στάθμη|σταθμη|επίπεδο|επιπεδο)\s+προμέτρηση)\s*:?\s*(-?\d+)/gi;
  let lm; const seen=new Set();
  while((lm=lvlRe.exec(section))){
    const lvl=lm[1]; const e0=lvlRe.lastIndex;
    const key=lvl+"@"+lm.index; if(seen.has(key)) continue; seen.add(key);
    const next=headers.filter(h=>h>e0); const end=next.length?Math.min(...next):section.length;
    const blk=section.slice(e0, Math.min(end, e0+2000));
    const parsed=parseBlock(lvl,blk);
    if(parsed.concrete>0 || Object.keys(parsed.dia).length) levels.push(parsed);
  }

  // Σύνολο κτιρίου: "Σύνολο κτιρίου", "Γενικό σύνολο", "Σύνολο έργου"
  let total=null;
  const btm=section.match(/(?:σύνολο\s+κτιρίου|γενικό\s+σύνολο|σύνολο\s+έργου|συνολικά)[\s\S]{0,2000}/i);
  if(btm) { const t=parseBlock("ΣΥΝΟΛΟ",btm[0]); if(t.concrete>0||Object.keys(t.dia).length) total=t; }
  if(!total && levels.length){ // fallback: άθροισμα σταθμών
    total={level:"ΣΥΝΟΛΟ",concrete:0,steel:0,formwork:0,dia:{}};
    levels.forEach(L=>{total.concrete+=L.concrete;total.steel+=L.steel;total.formwork+=L.formwork;
      Object.entries(L.dia).forEach(([d,v])=>{total.dia[d]=total.dia[d]||{m:0,kg:0};total.dia[d].m+=v.m;total.dia[d].kg+=v.kg;});});
  }
  if(!levels.length) return null;
  return {
    grade: gradeM?(gradeM[1]||gradeM[0]):"—",
    steelGrade: steelM?(steelM[1]||steelM[0]):"B500C",
    levels, total,
  };
}
function parseBlock(lvl,blk){
  const dia={};
  // πίνακας οπλισμού: "Φn  μήκος  βάρος" (κοινό σε όλα τα προγράμματα)
  const re=/Φ\s*(\d{1,2})\s+([\d.,]+)\s+([\d.,]+)/g; let m;
  while((m=re.exec(blk))){ const d="Φ"+m[1]; const mm=gnum(m[2]),kg=gnum(m[3]);
    if(!dia[d]) dia[d]={m:0,kg:0}; dia[d].m+=mm; dia[d].kg+=kg; }
  // Όγκος σκυροδέματος: "Ογκος/Όγκος Σκυροδέματος [m3] 55,20" — value μετά το unit
  const vol = blk.match(/[ΟΌ]γκος\s+[ΣΣ]κυροδ[έε]ματος\s*\[?m[3³]\]?\s*([\d.,]+)/i)
           || blk.match(/σκυρόδεμα\s*\[?m[3³]\]?\s*([\d.,]+)/i);
  // Βάρος οπλισμού: "Βάρος σιδηρού οπλισμού [Kg] 4159,75"
  const wt  = blk.match(/Βάρος\s+(?:σιδηρού\s+)?(?:οπλισμού|χάλυβα|χαλυβα)\s*\[?[Kk]g[r]?\]?\s*([\d.,]+)/i);
  // Ξυλότυπος: "Ολική επιφάνεια ξυλοτύπου [m²] 152,70"
  const fw  = blk.match(/(?:[ΟΌ]λική\s+επιφάνεια\s+ξυλοτύπου|ξυλότυπος|ξυλοτυπος)\s*\[?m[²2]\]?\s*([\d.,]+)/i);
  // Αναλογία kg/m3
  const ratio = blk.match(/[ΑΆ]ναλογία[^\[]*\[?[Kk]g\/m[3³]\]?\s*([\d.,]+)/i);
  return {
    level:lvl, dia,
    concrete: vol?gnum(vol[1]):0,
    steel: wt?gnum(wt[1]):0,
    formwork: fw?gnum(fw[1]):0,
    ratio: ratio?gnum(ratio[1]):0,
  };
}

/* ---------- Layer role UI ---------- */
function layerColor(name){let h=0;for(const c of name)h=(h*31+c.charCodeAt(0))%360;return `hsl(${h} 55% 55%)`;}
function renderLayerList(f){
  const c=$("#layerlist");c.innerHTML="";
  f.layers.forEach(l=>{
    const row=document.createElement("div");row.className="lrow";
    const sel=ROLES.map(r=>`<option ${f.layerRoles[l.name]===r?"selected":""}>${r}</option>`).join("");
    row.innerHTML=`<span class="sw" style="background:${layerColor(l.name)}"></span>
      <span class="ln" title="${l.name}">${l.name}</span>
      <span class="lc">${l.closed}▢ ${l.open}╱</span>
      <select class="role">${sel}</select>`;
    row.querySelector(".role").onchange=e=>{f.layerRoles[l.name]=e.target.value;};
    c.appendChild(row);
  });
}

/* ---------- DXF canvas render ---------- */
let cam={x:0,y:0,z:1};
function drawDXF(f){
  const host=$("#chost"),cv=$("#cv");
  const W=host.clientWidth,H=host.clientHeight;
  cv.width=W;cv.height=H;
  const ents=f.dxf.entities||[];
  // bounds
  let minx=1e18,miny=1e18,maxx=-1e18,maxy=-1e18,any=false;
  ents.forEach(e=>{
    const pts=e.vertices?polyPoints(e):(e.center?[{x:e.center.x,y:e.center.y}]:[]);
    pts.forEach(p=>{any=true;minx=Math.min(minx,p.x);miny=Math.min(miny,p.y);maxx=Math.max(maxx,p.x);maxy=Math.max(maxy,p.y);});
    if(e.center&&e.radius){any=true;minx=Math.min(minx,e.center.x-e.radius);maxx=Math.max(maxx,e.center.x+e.radius);
      miny=Math.min(miny,e.center.y-e.radius);maxy=Math.max(maxy,e.center.y+e.radius);}
  });
  if(!any){const ctx=cv.getContext("2d");ctx.clearRect(0,0,W,H);return;}
  const bw=maxx-minx||1,bh=maxy-miny||1;
  const fit=0.86*Math.min(W/bw,H/bh);
  cam.z=fit;cam.x=W/2-((minx+maxx)/2)*fit;cam.y=H/2+((miny+maxy)/2)*fit;
  f._bounds={minx,miny,maxx,maxy};
  paint(f);
  let stat=0,cl=0;ents.forEach(e=>{stat++;if(isClosedPoly(e))cl++;});
  $("#vStat").textContent=`${stat} entities · ${cl} κλειστά · ${f.layers.length} layers`;
}
// Μετατροπή ACI χρώματος (integer 0xRRGGBB) σε CSS
function aciToCss(n){
  if(n==null) return null;
  const r=(n>>16)&255, g=(n>>8)&255, b=n&255;
  return `rgb(${r},${g},${b})`;
}
// Χρώμα entity με σειρά προτεραιότητας: true color → layer color → λευκό
function entityColor(f,e){
  if(typeof e.color==="number") { const c=aciToCss(e.color); if(c) return c; }
  // layer color
  const layers=f.dxf.tables&&f.dxf.tables.layer&&f.dxf.tables.layer.layers;
  if(layers && layers[e.layer]){
    const lc=layers[e.layer].color;
    if(typeof lc==="number"){ const c=aciToCss(lc); if(c) return c; }
  }
  return "#d7e2ee"; // default ανοιχτό (σαν λευκό CAD background-dark)
}
function paint(f){
  const cv=$("#cv"),ctx=cv.getContext("2d");
  ctx.clearRect(0,0,cv.width,cv.height);
  const tx=p=>({X:p.x*cam.z+cam.x, Y:-p.y*cam.z+cam.y});
  (f.dxf.entities||[]).forEach(e=>{
    const col=entityColor(f,e);
    ctx.strokeStyle=col; ctx.lineWidth=1; ctx.fillStyle=col;
    if(e.type==="LINE"&&e.vertices){const a=tx(e.vertices[0]),b=tx(e.vertices[1]);
      ctx.beginPath();ctx.moveTo(a.X,a.Y);ctx.lineTo(b.X,b.Y);ctx.stroke();}
    else if((e.type==="LWPOLYLINE"||e.type==="POLYLINE")&&e.vertices){
      const p=polyPoints(e);if(!p.length)return;ctx.beginPath();
      p.forEach((pt,i)=>{const t=tx(pt);i?ctx.lineTo(t.X,t.Y):ctx.moveTo(t.X,t.Y);});
      if(isClosedPoly(e))ctx.closePath();
      ctx.stroke();}
    else if(e.type==="CIRCLE"){const c=tx(e.center);
      ctx.beginPath();ctx.arc(c.X,c.Y,e.radius*cam.z,0,7);ctx.stroke();}
    else if(e.type==="ARC"){const c=tx(e.center);
      ctx.beginPath();ctx.arc(c.X,c.Y,e.radius*cam.z,-e.endAngle*Math.PI/180,-e.startAngle*Math.PI/180);ctx.stroke();}
    else if(e.type==="ELLIPSE"&&e.center){const c=tx(e.center);
      const rx=Math.hypot(e.majorAxisEndPoint?.x||0,e.majorAxisEndPoint?.y||0)*cam.z;
      ctx.beginPath();ctx.ellipse(c.X,c.Y,rx,rx*(e.axisRatio||1),0,0,7);ctx.stroke();}
    else if((e.type==="TEXT"||e.type==="MTEXT")&&e.text){
      const pos=e.startPoint||e.position||e.insertionPoint; if(!pos)return;
      const t=tx(pos); const h=(e.textHeight||e.height||0.2)*cam.z;
      if(h>=4){ // μόνο αν είναι ευανάγνωστο
        ctx.fillStyle=col; ctx.font=`${Math.min(h,40)}px sans-serif`;
        ctx.save(); ctx.translate(t.X,t.Y);
        if(e.rotation) ctx.rotate(-e.rotation*Math.PI/180);
        ctx.fillText((""+e.text).replace(/\\[A-Za-z][^;]*;/g,"").replace(/[{}]/g,""),0,0);
        ctx.restore();
      }
    }
  });
}
// pan/zoom
(()=>{const host=$("#chost");let drag=false,lx,ly;
  host.addEventListener("mousedown",e=>{drag=true;lx=e.clientX;ly=e.clientY;});
  window.addEventListener("mouseup",()=>drag=false);
  window.addEventListener("mousemove",e=>{if(!drag)return;cam.x+=e.clientX-lx;cam.y+=e.clientY-ly;lx=e.clientX;ly=e.clientY;const f=cur();if(f&&f.kind==="dxf")paint(f);});
  host.addEventListener("wheel",e=>{e.preventDefault();const f=cur();if(!f||f.kind!=="dxf")return;
    const r=host.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    const k=e.deltaY<0?1.12:0.89;cam.x=mx-(mx-cam.x)*k;cam.y=my-(my-cam.y)*k;cam.z*=k;paint(f);},{passive:false});
})();
$("#vFit").onclick=()=>{const f=cur();if(f&&f.kind==="dxf")drawDXF(f);};

/* ---------- PDF render ---------- */
async function renderPDF(f){
  const pg=await f.pdfDoc.getPage(f.page);
  const vp=pg.getViewport({scale:f.scale});
  const cv=$("#pcv"),ctx=cv.getContext("2d");
  cv.width=vp.width;cv.height=vp.height;
  await pg.render({canvasContext:ctx,viewport:vp}).promise;
  $("#pPage").textContent=`${f.page}/${f.pdfDoc.numPages}`;
}
$("#pPrev").onclick=()=>{const f=cur();if(f&&f.page>1){f.page--;renderPDF(f);}};
$("#pNext").onclick=()=>{const f=cur();if(f&&f.page<f.pdfDoc.numPages){f.page++;renderPDF(f);}};
$("#pZin").onclick=()=>{const f=cur();if(f){f.scale*=1.2;renderPDF(f);}};
$("#pZout").onclick=()=>{const f=cur();if(f){f.scale/=1.2;renderPDF(f);}};

/* ---------- Tabs ---------- */
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  document.querySelectorAll(".view").forEach(x=>x.classList.remove("active"));
  t.classList.add("active");$("#view-"+t.dataset.view).classList.add("active");
  if(t.dataset.view==="viewer"){const f=cur();if(f&&f.kind==="dxf")drawDXF(f);}
});

/* ---------- Assumptions editors ---------- */
function renderRebarTbl(){
  const tb=$("#rebarTbl tbody");if(!tb)return;tb.innerHTML="";
  state.rebar.forEach((r,i)=>{
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td><input value="${r.dia}" data-k="dia"></td>
      <td><input type="number" step="0.001" value="${r.kgm}" data-k="kgm"></td>
      <td><button class="rm" style="background:none;border:0;color:var(--faint);font-size:16px">×</button></td>`;
    tr.querySelectorAll("[data-k]").forEach(inp=>inp.onchange=e=>{
      const k=e.target.dataset.k;r[k]=k==="kgm"?parseFloat(e.target.value):e.target.value;});
    tr.querySelector(".rm").onclick=()=>{state.rebar.splice(i,1);renderRebarTbl();};
    tb.appendChild(tr);
  });
}
const addRebarBtn=$("#addRebar"); if(addRebarBtn) addRebarBtn.onclick=()=>{state.rebar.push({dia:"Φ",kgm:0,key:""});renderRebarTbl();};

/* ---------- Calculation ---------- */
function refreshCalcBtn(){ /* το κουμπί ανάγνωσης οπλισμού ενεργοποιείται ανά σχέδιο */ }

// Κουμπί «Διάβασε οπλισμό από σχέδιο»
document.addEventListener("click",e=>{
  if(e.target && e.target.id==="readRebarBtn") readRebar();
});
function readRebar(){
  const hasDxf=state.files.some(f=>f.kind==="dxf");
  if(!hasDxf){ toast("Δεν υπάρχει σχέδιο DXF.",true); return; }
  state.rebarRead=true;
  renderResults();
  const rt=document.querySelector('.tab[data-view="results"]'); if(rt) rt.click();
  const cut=buildCutFromDxf();
  if(cut.items.length) toast(`✓ Διαβάστηκαν ${cut.items.length} θέσεις οπλισμού.`);
  else toast("Δεν βρέθηκαν labels οπλισμού στο σχέδιο (π.χ. 4Φ20+8Φ16).",true);
}

/* ---------- Results render ---------- */
function renderResults(){
  const pad=$("#resPad");
  if(!state.rebarRead && !state.study){return;}
  let html="";

  // ===== Στατικό τεύχος (μελέτη) =====
  if(state.study){
    const S=state.study;
    html+=`<h1 class="h1">Στατικό τεύχος — παραδοχές μελέτης</h1>
      <p class="sub">${S.fileName||""} · Σκυρόδεμα <b style="color:var(--ink)">${S.grade}</b> · Χάλυβας <b style="color:var(--ink)">${S.steelGrade}</b></p>
      <div class="cards">
        <div class="card b"><div class="k"><span class="pill beton"></span>Μπετόν μελέτης</div>
          <div class="v">${fmt(S.total.concrete)} <span class="u">m³</span></div></div>
        <div class="card s"><div class="k"><span class="pill steel"></span>Οπλισμός μελέτης</div>
          <div class="v">${fmt(S.total.steel,0)} <span class="u">kg</span></div></div>
        <div class="card"><div class="k">Αναλογία</div>
          <div class="v">${fmt(S.total.concrete?S.total.steel/S.total.concrete:0,0)} <span class="u">kg/m³</span></div></div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:18px">
        <button class="btn sm" id="expStudyXls">⬇ Excel τεύχους</button>
      </div>`;

    // all diameters present
    const allDia=new Set();S.levels.forEach(L=>Object.keys(L.dia).forEach(d=>allDia.add(d)));
    const dias=[...allDia].sort((a,b)=>parseInt(a.slice(1))-parseInt(b.slice(1)));

    html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
      Ποσότητες ανά στάθμη (από το τεύχος)</h3>
      <table class="tbl"><thead><tr><th>Στάθμη</th>
      <th class="num">Μπετόν (m³)</th><th class="num">Ξυλότυπος (m²)</th>
      <th class="num">Οπλισμός (kg)</th><th class="num">kg/m³</th>
      ${dias.map(d=>`<th class="num">${d}</th>`).join("")}</tr></thead><tbody>`;
    S.levels.forEach(L=>{
      html+=`<tr><td>όροφος ${L.level}</td>
        <td class="num">${fmt(L.concrete)}</td><td class="num">${fmt(L.formwork)}</td>
        <td class="num">${fmt(L.steel,0)}</td><td class="num">${fmt(L.ratio||(L.concrete?L.steel/L.concrete:0),1)}</td>
        ${dias.map(d=>`<td class="num">${L.dia[d]?fmt(L.dia[d].kg,0):"—"}</td>`).join("")}</tr>`;
    });
    html+=`<tr class="totrow"><td>ΣΥΝΟΛΟ ΚΤΙΡΙΟΥ</td>
      <td class="num">${fmt(S.total.concrete)}</td><td class="num">${fmt(S.total.formwork)}</td>
      <td class="num">${fmt(S.total.steel,0)}</td>
      <td class="num">${fmt(S.total.concrete?S.total.steel/S.total.concrete:0,1)}</td>
      ${dias.map(d=>`<td class="num">${S.total.dia[d]?fmt(S.total.dia[d].kg,0):"—"}</td>`).join("")}</tr>
      </tbody></table>`;

    // ===== ΠΙΝΑΚΑΣ ΚΟΠΗΣ από τεύχος (αξιόπιστος) =====
    html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
      <span class="pill steel"></span>Πίνακας κοπής οπλισμού — από τεύχος (αξιόπιστος)</h3>
      <p class="note" style="margin-top:0">Συγκεντρωτικά ανά διάμετρο, με πλήθος εμπορικών ράβδων ${fmt(state.barLength,0)} m. Τα μήκη είναι τα πραγματικά της μελέτης.</p>
      <table class="tbl"><thead><tr><th>Διάμετρος</th><th class="num">Μήκος (m)</th>
      <th class="num">Βάρος (kg)</th><th class="num">Ράβδοι ${fmt(state.barLength,0)}m</th>
      <th class="num">kg/m</th></tr></thead><tbody>`;
    let tBars=0;
    dias.forEach(d=>{const v=S.total.dia[d]||{m:0,kg:0};
      const kgm = v.m>0 ? v.kg/v.m : 0;
      const bars = Math.ceil(v.m/(state.barLength||12));
      tBars+=bars;
      html+=`<tr><td>${d}</td><td class="num">${fmt(v.m)}</td><td class="num">${fmt(v.kg,0)}</td>
        <td class="num">${bars}</td><td class="num">${fmt(kgm,3)}</td></tr>`;});
    html+=`<tr class="totrow"><td>Σύνολο</td><td></td><td class="num">${fmt(S.total.steel,0)}</td>
      <td class="num">${tBars}</td><td></td></tr></tbody></table>`;

    // ανά στάθμη — πλήθος ράβδων
    html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
      Ράβδοι ${fmt(state.barLength,0)}m ανά στάθμη &amp; διάμετρο</h3>
      <table class="tbl"><thead><tr><th>Στάθμη</th>
      ${dias.map(d=>`<th class="num">${d}</th>`).join("")}<th class="num">Σύνολο</th></tr></thead><tbody>`;
    S.levels.forEach(L=>{
      let rowBars=0;
      const cells=dias.map(d=>{ if(!L.dia[d]) return `<td class="num">—</td>`;
        const b=Math.ceil(L.dia[d].m/(state.barLength||12)); rowBars+=b; return `<td class="num">${b}</td>`; });
      html+=`<tr><td>όροφος ${L.level}</td>${cells.join("")}<td class="num"><b>${rowBars}</b></td></tr>`;
    });
    html+=`</tbody></table>`;
  }

  // ===== ΠΙΝΑΚΑΣ ΚΟΠΗΣ από οπλισμό σχεδίου (DXF labels) =====
  if(state.rebarRead){
    html+=renderRebarCut();
  }

  if(!state.study && !state.rebarRead){
    html=`<div class="empty"><div><div class="big">▦</div>
      Ανέβασε <b>τεύχος (PDF)</b> για ποσότητες μελέτης,<br>ή πάτησε «Διάβασε οπλισμό» σε ένα <b>σχέδιο (DXF)</b>.</div></div>`;
  }

  pad.innerHTML=html;
  const x1=$("#expXls"); if(x1) x1.onclick=exportXlsx;
  const x3=$("#expStudyXls"); if(x3) x3.onclick=exportStudyXlsx;
}

// Πίνακας κοπής από τα labels του σχεδίου
function renderRebarCut(){
  const cut=buildCutFromDxf();
  const A=state.cutAssume;
  if(!cut.items.length){
    return `<h1 class="h1" style="margin-top:24px">Οπλισμός από σχέδιο</h1>
      <p class="note">Δεν βρέθηκαν labels οπλισμού (π.χ. 4Φ20+8Φ16, Σ Φ8/10) στα σχέδια. Βεβαιώσου ότι το DXF περιέχει το κείμενο του οπλισμού.</p>`;
  }
  let html=`<h1 class="h1" style="margin-top:24px">Πίνακας κοπής οπλισμού — από σχέδιο</h1>
    <p class="sub">Διαβασμένος από τα labels του DXF · ράβδος ${fmt(state.barLength,0)}m</p>
    <div style="background:var(--beton-soft);border:1px solid var(--beton);border-radius:8px;padding:9px 12px;margin-bottom:14px;font-size:11px;line-height:1.5;color:var(--ink)">
    ⚠ Τα <b>μήκη</b> είναι εκτιμήσεις βάσει παραδοχών (ύψος ορόφου ${fmt(A.storeyHeight)}m, μάτιση ${fmt(A.lap)}m, επικάλυψη ${fmt(A.cover)}m, γάντζος ${fmt(A.hook)}m — ρυθμίζονται στις «Παραδοχές»). Το <b>πλήθος &amp; οι διάμετροι</b> διαβάζονται ακριβώς από το σχέδιο.</div>
    <div style="display:flex;gap:8px;margin-bottom:16px"><button class="btn sm" id="expXls">⬇ Excel</button></div>`;

  // αναλυτικά ανά στάθμη
  const bySrc={}; cut.items.forEach(it=>{(bySrc[it.source]=bySrc[it.source]||[]).push(it);});
  html+=`<table class="tbl"><thead><tr><th>Σχέδιο</th><th>Τύπος</th><th>Διάμετρος</th>
    <th class="num">Πλήθος</th><th class="num">Μήκος/τεμ (m)</th><th class="num">Ολικό (m)</th>
    <th class="num">Βάρος (kg)</th></tr></thead><tbody>`;
  let gTot=0;
  Object.entries(bySrc).forEach(([src,arr])=>{
    html+=`<tr class="lvlhead"><td colspan="7">▸ ${src}</td></tr>`;
    arr.forEach(it=>{const tot=it.count*it.lenEach, kg=tot*kgPerM(it.dia); gTot+=kg;
      html+=`<tr><td></td><td>${it.type}</td><td>${it.dia}</td><td class="num">${it.count}</td>
        <td class="num">${fmt(it.lenEach)}</td><td class="num">${fmt(tot)}</td><td class="num">${fmt(kg,1)}</td></tr>`;});
  });
  html+=`<tr class="totrow"><td colspan="6">ΕΚΤΙΜΩΜΕΝΟ ΣΥΝΟΛΟ</td><td class="num">${fmt(gTot,0)} kg</td></tr></tbody></table>`;

  // συγκεντρωτικά ανά διάμετρο + ράβδοι + σύγκριση τεύχους
  html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
    Σύνολα ανά διάμετρο &amp; ράβδοι ${fmt(state.barLength,0)}m</h3>
    <table class="tbl"><thead><tr><th>Διάμετρος</th><th class="num">Ολικό μήκος (m)</th>
    <th class="num">Βάρος (kg)</th><th class="num">Ράβδοι ${fmt(state.barLength,0)}m</th>
    ${state.study?'<th class="num">Τεύχος (m)</th><th class="num">Απόκλιση</th>':''}</tr></thead><tbody>`;
  Object.values(cut.byDia).sort((a,b)=>parseInt(a.dia.slice(1))-parseInt(b.dia.slice(1))).forEach(v=>{
    const kg=v.totLen*kgPerM(v.dia), bars=Math.ceil(v.totLen/(state.barLength||12));
    let extra="";
    if(state.study&&state.study.total&&state.study.total.dia[v.dia]){
      const tm=state.study.total.dia[v.dia].m, pct=tm?((v.totLen-tm)/tm*100):0;
      const col=Math.abs(pct)>15?"color:var(--warn)":"color:var(--ok)";
      extra=`<td class="num">${fmt(tm)}</td><td class="num" style="${col}">${(pct>0?"+":"")+fmt(pct,0)}%</td>`;
    } else if(state.study){ extra=`<td class="num">—</td><td class="num">—</td>`; }
    html+=`<tr><td>${v.dia}</td><td class="num">${fmt(v.totLen)}</td><td class="num">${fmt(kg,0)}</td>
      <td class="num">${bars}</td>${extra}</tr>`;
  });
  html+=`</tbody></table>`;
  if(state.study) html+=`<p class="note">Η «Απόκλιση» συγκρίνει την εκτίμηση από το σχέδιο με τα πραγματικά μήκη του τεύχους.</p>`;
  return html;
}

function exportStudyXlsx(){
  const S=state.study;
  const allDia=new Set();S.levels.forEach(L=>Object.keys(L.dia).forEach(d=>allDia.add(d)));
  const dias=[...allDia].sort((a,b)=>parseInt(a.slice(1))-parseInt(b.slice(1)));
  const rows=[["Στάθμη","Μπετόν (m³)","Ξυλότυπος (m²)","Οπλισμός (kg)","kg/m³",...dias.map(d=>d+" (kg)")]];
  S.levels.forEach(L=>rows.push(["όροφος "+L.level,L.concrete,L.formwork,L.steel,
    Number((L.ratio||(L.concrete?L.steel/L.concrete:0)).toFixed(1)),
    ...dias.map(d=>L.dia[d]?Number(L.dia[d].kg.toFixed(1)):"")]));
  rows.push(["ΣΥΝΟΛΟ",S.total.concrete,S.total.formwork,S.total.steel,
    Number((S.total.concrete?S.total.steel/S.total.concrete:0).toFixed(1)),
    ...dias.map(d=>S.total.dia[d]?Number(S.total.dia[d].kg.toFixed(1)):"")]);
  const ws=XLSX.utils.aoa_to_sheet(rows);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Τεύχος μελέτης");
  XLSX.writeFile(wb,"teuxos_prometrisi.xlsx");
}

/* ---------- Exports ---------- */
function exportXlsx(){
  const wb=XLSX.utils.book_new();
  let added=false;

  // Φύλλο: Πίνακας κοπής από σχέδιο (DXF labels)
  try{
    const cut=buildCutFromDxf();
    if(cut.items.length){
      const cr=[["Σχέδιο","Τύπος","Διάμετρος","Πλήθος","Μήκος/τεμ (m)","Ολικό (m)","Βάρος (kg)"]];
      cut.items.forEach(it=>{const tot=it.count*it.lenEach;
        cr.push([it.source,it.type,it.dia,it.count,Number(it.lenEach.toFixed(2)),
          Number(tot.toFixed(2)),Number((tot*kgPerM(it.dia)).toFixed(1))]);});
      cr.push([]);
      cr.push(["ΑΝΑ ΔΙΑΜΕΤΡΟ","","","Ολικό μήκος (m)","Βάρος (kg)","Ράβδοι "+state.barLength+"m",""]);
      Object.values(cut.byDia).sort((a,b)=>parseInt(a.dia.slice(1))-parseInt(b.dia.slice(1))).forEach(v=>{
        cr.push([v.dia,"","",Number(v.totLen.toFixed(2)),Number((v.totLen*kgPerM(v.dia)).toFixed(1)),
          Math.ceil(v.totLen/(state.barLength||12)),""]);});
      const ws2=XLSX.utils.aoa_to_sheet(cr);
      ws2["!cols"]=[{wch:16},{wch:14},{wch:10},{wch:12},{wch:14},{wch:14},{wch:12}];
      XLSX.utils.book_append_sheet(wb,ws2,"Κοπή (σχέδιο)"); added=true;
    }
  }catch(e){console.warn(e);}

  // Φύλλο: Πίνακας κοπής από τεύχος (αξιόπιστος)
  if(state.study && state.study.total){
    const S=state.study;
    const allDia=new Set();S.levels.forEach(L=>Object.keys(L.dia).forEach(d=>allDia.add(d)));
    const dias=[...allDia].sort((a,b)=>parseInt(a.slice(1))-parseInt(b.slice(1)));
    const tr=[["Διάμετρος","Μήκος (m)","Βάρος (kg)","Ράβδοι "+state.barLength+"m"]];
    dias.forEach(d=>{const v=S.total.dia[d]||{m:0,kg:0};
      tr.push([d,Number(v.m.toFixed(2)),Number(v.kg.toFixed(1)),Math.ceil(v.m/(state.barLength||12))]);});
    tr.push(["ΣΥΝΟΛΟ","",Number(S.total.steel.toFixed(1)),""]);
    const ws3=XLSX.utils.aoa_to_sheet(tr);
    ws3["!cols"]=[{wch:12},{wch:14},{wch:14},{wch:14}];
    XLSX.utils.book_append_sheet(wb,ws3,"Κοπή (τεύχος)"); added=true;
  }

  if(!added){ toast("Δεν υπάρχουν δεδομένα για εξαγωγή.",true); return; }
  XLSX.writeFile(wb,"oplismos.xlsx");
}

/* ---------- init ---------- */
renderRebarTbl();

// Προειδοποίηση αν δεν φόρτωσαν οι βιβλιοθήκες CDN
if (window.__cdnFail || typeof DxfParser==="undefined") {
  setTimeout(()=>toast("Κάποιες βιβλιοθήκες δεν φόρτωσαν (CDN). Έλεγξε σύνδεση & κάνε ανανέωση.",true), 400);
}

// ζούμι/πρέσες global settings
// Πίνακας κοπής — παραδοχές
const rerender=()=>{ if(state.rebarRead||state.study) renderResults(); };
const bl=$("#barLength"); if(bl) bl.onchange=e=>{ state.barLength=Math.max(6,parseFloat(e.target.value)||12); rerender(); };
const sh=$("#storeyHeight"); if(sh) sh.onchange=e=>{ state.cutAssume.storeyHeight=Math.max(1,parseFloat(e.target.value)||3); rerender(); };
const lp=$("#lap"); if(lp) lp.onchange=e=>{ state.cutAssume.lap=Math.max(0,parseFloat(e.target.value)||0); rerender(); };
const cv=$("#cover"); if(cv) cv.onchange=e=>{ state.cutAssume.cover=Math.max(0,parseFloat(e.target.value)||0); rerender(); };
const hk=$("#hook"); if(hk) hk.onchange=e=>{ state.cutAssume.hook=Math.max(0,parseFloat(e.target.value)||0); rerender(); };
