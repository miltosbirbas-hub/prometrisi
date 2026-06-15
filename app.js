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

$("#file").addEventListener("change",e=>handleFiles(e.target.files));
const drop=$("#drop");
drop.style.cursor="pointer";
// Το click ανοίγει native μέσω <label for="file"> — εδώ μόνο drag & drop
["dragover","dragenter"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add("hot");}));
["dragleave","drop"].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove("hot");}));
drop.addEventListener("drop",e=>{e.preventDefault();handleFiles(e.dataTransfer.files);});

async function handleFiles(list){
  for(const f of list){
    const ext=f.name.split(".").pop().toLowerCase();
    if(ext==="dxf"){
      const txt=await f.text();
      let dxf;
      const P=getParser(); if(!P) continue;
      try{ dxf=P.parseSync(txt); }
      catch(err){ toast("Σφάλμα ανάγνωσης DXF: "+f.name,true); console.error(err); continue; }
      const layers=collectLayers(dxf);
      const roles={};
      layers.forEach(l=>roles[l.name]=guessRole(l.name));
      state.files.push({id:uid(),name:f.name,kind:"dxf",dxf,layers,
        level:guessLevel(f.name),units:1,layerRoles:roles});
    } else if(ext==="pdf"){
      const buf=await f.arrayBuffer();
      let doc; try{ doc=await pdfjsLib.getDocument({data:buf.slice(0)}).promise; }
      catch(err){ toast("Σφάλμα PDF: "+f.name,true); continue; }
      const fileObj={id:uid(),name:f.name,kind:"pdf",pdfDoc:doc,page:1,scale:1.3};
      state.files.push(fileObj);
      // try to parse as structural study (τεύχος)
      try{
        const fullText=await extractPdfText(doc);
        const parsed=parseStudy(fullText);
        if(parsed){ parsed.fileName=f.name; state.study=parsed;
          const tot = parsed.total ? fmt(parsed.total.concrete) : "—";
          toast(`✓ Τεύχος: ${parsed.levels.length} στάθμες, ${tot} m³ — δες «Προμέτρηση & Τεύχος»`);
          renderResults();
          // αυτόματη μετάβαση στην καρτέλα αποτελεσμάτων
          const rt=document.querySelector('.tab[data-view="results"]'); if(rt) rt.click();
        } else {
          // PDF που δεν είναι αναγνωρίσιμο τεύχος Fespa — απλό σχέδιο/ξυλότυπος
          toast(`«${f.name}»: προβολή μόνο (δεν είναι τεύχος Fespa με πίνακες προμέτρησης).`);
        }
      }catch(err){ console.warn("study parse failed",err);
        toast("Δεν διαβάστηκε το PDF ως τεύχος — προβάλλεται μόνο.",true); }
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
      <span class="nm">${f.name}</span>
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
  $("#lvlSec").style.display="none";$("#layerSec").style.display="none";
}

function setActive(id){
  state.activeId=id;
  const f=state.files.find(x=>x.id===id);
  renderFiles();
  $("#vEmpty").style.display="none";
  if(f.kind==="dxf"){
    $("#dxfViewer").style.display="flex";$("#pdfViewer").style.display="none";
    $("#lvlSec").style.display="block";$("#layerSec").style.display="block";
    $("#lvlName").value=f.level; $("#units").value=String(f.units);
    $("#vName").textContent=f.name;
    renderLayerList(f);
    drawDXF(f);
  } else {
    $("#dxfViewer").style.display="none";$("#pdfViewer").style.display="flex";
    $("#lvlSec").style.display="none";$("#layerSec").style.display="none";
    $("#pName").textContent=f.name;
    renderPDF(f);
  }
}

$("#lvlName").addEventListener("input",e=>{const f=cur();if(f)f.level=e.target.value;});
$("#units").addEventListener("change",e=>{const f=cur();if(f){f.units=parseFloat(e.target.value);drawDXF(f);}});
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

// Detects & parses a Fespa-style structural study. Returns null if not recognised.
function parseStudy(txt){
  if(!/Συνολική προμέτρηση κτιρίου|Προμέτρηση:\s*Σύνολο/.test(txt)) return null;
  const startIdx=txt.indexOf("Συνολική προμέτρηση κτιρίου");
  const section = startIdx>=0 ? txt.slice(startIdx) : txt;

  // materials (πολλαπλές μορφές: "Σκυρόδεμα: C30/37", "Σκυρόδεμα C25/30", ": C25/30")
  const gradeM = txt.match(/Σκυρόδεμα[:\s]*\s*(C\d+\/\d+)/) || txt.match(/\bC(?:12|16|20|25|30|35|40|45|50)\/\d+\b/);
  const steelM = txt.match(/Χάλυβας[:\s]*\s*(B\d+\w*)/) || txt.match(/\bB500[A-C]\b/);

  // per-level blocks: "Σύνολο ορόφου :N"
  const headerRe=/Προμέτρηση[:\s]/g;
  const headers=[]; let hm; while((hm=headerRe.exec(section))) headers.push(hm.index);

  const levels=[];
  const lvlRe=/Σύνολο ορόφου\s*:\s*(-?\d+)/g; let lm;
  while((lm=lvlRe.exec(section))){
    const lvl=lm[1];
    const e0=lvlRe.lastIndex;
    const next=headers.filter(h=>h>e0); const end=next.length?Math.min(...next):section.length;
    const blk=section.slice(e0,end);
    levels.push(parseBlock(lvl,blk));
  }

  // building total — anchor to the standalone final line, widen window
  let total=null;
  const btm=section.match(/Προμέτρηση:\s*Σύνολο κτιρίου\s*\nΠοσότητες[\s\S]{0,1800}/);
  if(btm) total=parseBlock("ΣΥΝΟΛΟ",btm[0]);
  if(!total && levels.length){ // fallback: sum
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
  const re=/Φ(\d{1,2})\s+([\d.,]+)\s+([\d.,]+)/g; let m;
  while((m=re.exec(blk))){ const d="Φ"+m[1]; const mm=gnum(m[2]),kg=gnum(m[3]);
    if(!dia[d]) dia[d]={m:0,kg:0}; dia[d].m+=mm; dia[d].kg+=kg; }
  const vol=blk.match(/Ογκος Σκυροδέματος\s*\[m3\]\s*([\d.,]+)/);
  const wt=blk.match(/Βάρος σιδηρού οπλισμού\s*\[Kg\]\s*([\d.,]+)/);
  const fw=blk.match(/Ολική επιφάνεια ξυλοτύπου\s*\[m²\]\s*([\d.,]+)/);
  const ratio=blk.match(/Αναλογία Σιδ\/Σκυροδέμ\.\s*\[Kg\/m3\]\s*([\d.,]+)/);
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
function paint(f){
  const cv=$("#cv"),ctx=cv.getContext("2d");
  ctx.clearRect(0,0,cv.width,cv.height);
  const tx=p=>({X:p.x*cam.z+cam.x, Y:-p.y*cam.z+cam.y});
  (f.dxf.entities||[]).forEach(e=>{
    const role=f.layerRoles[e.layer||"0"];
    const rc=state.beton.find(b=>b.role===role);
    let col=rc?rc.color:(role==="ΟΠΛΙΣΜΟΣ"?"#3fa7d6":(role==="ΑΓΝΟΗΣΗ"?"#33424f":layerColor(e.layer||"0")));
    ctx.strokeStyle=col;ctx.lineWidth=role==="ΟΠΛΙΣΜΟΣ"?0.8:1.1;
    ctx.fillStyle=col+"22";
    if(e.type==="LINE"&&e.vertices){const a=tx(e.vertices[0]),b=tx(e.vertices[1]);
      ctx.beginPath();ctx.moveTo(a.X,a.Y);ctx.lineTo(b.X,b.Y);ctx.stroke();}
    else if((e.type==="LWPOLYLINE"||e.type==="POLYLINE")&&e.vertices){
      const p=polyPoints(e);if(!p.length)return;ctx.beginPath();
      p.forEach((pt,i)=>{const t=tx(pt);i?ctx.lineTo(t.X,t.Y):ctx.moveTo(t.X,t.Y);});
      if(isClosedPoly(e)){ctx.closePath();if(rc)ctx.fill();}
      ctx.stroke();}
    else if(e.type==="CIRCLE"){const c=tx(e.center);
      ctx.beginPath();ctx.arc(c.X,c.Y,e.radius*cam.z,0,7);if(rc)ctx.fill();ctx.stroke();}
    else if(e.type==="ARC"){const c=tx(e.center);
      ctx.beginPath();ctx.arc(c.X,c.Y,e.radius*cam.z,-e.endAngle*Math.PI/180,-e.startAngle*Math.PI/180);ctx.stroke();}
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
function renderBetonTbl(){
  const tb=$("#betonTbl tbody");tb.innerHTML="";
  state.beton.forEach((r,i)=>{
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td><input value="${r.role}" data-k="role"></td>
      <td><select data-k="type">
        <option value="area" ${r.type==="area"?"selected":""}>Εμβαδόν × ύψος → m³</option>
        <option value="length" ${r.type==="length"?"selected":""}>Μήκος × διατομή → m³</option>
      </select></td>
      <td><input type="number" step="0.01" value="${r.thick}" data-k="thick"></td>
      <td><input type="number" step="1" value="${r.kg}" data-k="kg"></td>
      <td><input type="color" value="${r.color}" data-k="color"></td>
      <td><button class="rm" style="background:none;border:0;color:var(--faint);font-size:16px">×</button></td>`;
    tr.querySelectorAll("[data-k]").forEach(inp=>inp.onchange=e=>{
      const k=e.target.dataset.k;r[k]=(k==="thick"||k==="kg")?parseFloat(e.target.value):e.target.value;
      const f=cur();if(f&&f.kind==="dxf")paint(f);
    });
    tr.querySelector(".rm").onclick=()=>{state.beton.splice(i,1);renderBetonTbl();};
    tb.appendChild(tr);
  });
}
$("#addBeton").onclick=()=>{state.beton.push({role:"ΝΕΟ",type:"area",thick:0.20,kg:120,color:"#888888"});renderBetonTbl();};

function renderRebarTbl(){
  const tb=$("#rebarTbl tbody");tb.innerHTML="";
  state.rebar.forEach((r,i)=>{
    const tr=document.createElement("tr");
    tr.innerHTML=`
      <td><input value="${r.dia}" data-k="dia"></td>
      <td><input type="number" step="0.001" value="${r.kgm}" data-k="kgm"></td>
      <td><input value="${r.key}" data-k="key" placeholder="π.χ. 12"></td>
      <td><button class="rm" style="background:none;border:0;color:var(--faint);font-size:16px">×</button></td>`;
    tr.querySelectorAll("[data-k]").forEach(inp=>inp.onchange=e=>{
      const k=e.target.dataset.k;r[k]=k==="kgm"?parseFloat(e.target.value):e.target.value;});
    tr.querySelector(".rm").onclick=()=>{state.rebar.splice(i,1);renderRebarTbl();};
    tb.appendChild(tr);
  });
}
$("#addRebar").onclick=()=>{state.rebar.push({dia:"Φ",kgm:0,key:""});renderRebarTbl();};

/* ---------- Calculation ---------- */
function refreshCalcBtn(){
  $("#calcBtn").disabled=!state.files.some(f=>f.kind==="dxf");
}
$("#calcBtn").onclick=calculate;

function calculate(){
  const levels={};
  state.files.filter(f=>f.kind==="dxf").forEach(f=>{
    const lvl=f.level||f.name;
    if(!levels[lvl]) levels[lvl]={name:lvl,beton:{},steelByDia:{},steelTotal:0};
    const L=levels[lvl];
    const u=f.units, u2=u*u;
    (f.dxf.entities||[]).forEach(e=>{
      const role=f.layerRoles[e.layer||"0"];
      if(!role||role==="—"||role==="ΑΓΝΟΗΣΗ"||role==="ΙΣΟΥΨΕΙΣ") return;
      if(role==="ΟΠΛΙΣΜΟΣ"){
        const len=entityLength(e)*u;
        const dia=matchDia(e.layer||"0");
        if(!L.steelByDia[dia.dia]) L.steelByDia[dia.dia]={len:0,kgm:dia.kgm,kg:0};
        L.steelByDia[dia.dia].len+=len;
        return;
      }
      const rc=state.beton.find(b=>b.role===role);
      if(!rc) return;
      if(!L.beton[role]) L.beton[role]={role,area:0,len:0,vol:0,steelKg:0,kgPerM3:rc.kg};
      if(rc.type==="area"){
        if(isClosedPoly(e)){const a=entityArea(e)*u2; L.beton[role].area+=a; L.beton[role].vol+=a*rc.thick;}
      } else {
        const ln=entityLength(e)*u; L.beton[role].len+=ln; L.beton[role].vol+=ln*rc.thick; // thick = διατομή m²
      }
    });
    // default rebar from kg/m³ if no explicit rebar layer mapped
    Object.values(L.beton).forEach(b=>{ b.steelKg = b.vol * b.kgPerM3; });
  });
  // finalize steel
  Object.values(levels).forEach(L=>{
    Object.values(L.steelByDia).forEach(s=>{s.kg=s.len*s.kgm;L.steelTotal+=s.kg;});
  });
  // ζούμι / πρέσες ανά στάθμη
  Object.values(levels).forEach(L=>{
    const net=Object.values(L.beton).reduce((a,b)=>a+b.vol,0);
    const cfg=state.levelCasting[L.name] || {};
    // αυτόματη εκτίμηση πρεσών αν δεν έχει οριστεί
    const pumps = (cfg.pumps!=null) ? cfg.pumps : Math.max(1, Math.ceil(net/(state.defaultLoad||8)));
    const waste = pumps * (state.pumpWaste||0);
    L.netConcrete = net;
    L.pumps = pumps;
    L.waste = waste;
    L.grossConcrete = net + waste;
    L.castMode = cfg.mode || "mono";
  });
  state.results={levels};
  renderResults();
  document.querySelector('.tab[data-view="results"]').click();
  toast("Η προμέτρηση ολοκληρώθηκε.");
}
function matchDia(layer){
  const u=layer.toUpperCase().replace(/\s/g,"");
  for(const r of state.rebar){ if(r.key && (u.includes(r.key)) ) return r; }
  const m=u.match(/(?:Φ|FI|D)(\d{1,2})/);
  if(m){const k=m[1];const f=state.rebar.find(r=>r.key===k);if(f)return f;return{dia:"Φ"+k,kgm:0.00617*k*k/10*1.0||0.888,key:k};}
  return {dia:"Άγνωστη Φ",kgm:0.888,key:""};
}

/* ---------- Results render ---------- */
function renderResults(){
  const pad=$("#resPad");
  if(!state.results && !state.study){return;}
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

    // steel by diameter (kg) summary table
    html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
      <span class="pill steel"></span>Σίδηρος ανά διάμετρο (σύνολο κτιρίου)</h3>
      <table class="tbl"><thead><tr><th>Διάμετρος</th><th class="num">Μήκος (m)</th><th class="num">Βάρος (kg)</th></tr></thead><tbody>`;
    dias.forEach(d=>{const v=S.total.dia[d]||{m:0,kg:0};
      html+=`<tr><td>${d}</td><td class="num">${fmt(v.m)}</td><td class="num">${fmt(v.kg,0)}</td></tr>`;});
    html+=`<tr class="totrow"><td>Σύνολο</td><td></td><td class="num">${fmt(S.total.steel,0)}</td></tr></tbody></table>`;
  }

  // ===== Σύγκριση μελέτη vs σχέδια =====
  if(state.study && state.results){
    html+=renderComparison();
  }

  // ===== Προμέτρηση από DXF =====
  if(state.results){
    html+=renderDxfResults();
  }

  pad.innerHTML=html;
  const x1=$("#expXls"); if(x1) x1.onclick=exportXlsx;
  const x2=$("#expPdf"); if(x2) x2.onclick=exportPdf;
  const x3=$("#expStudyXls"); if(x3) x3.onclick=exportStudyXlsx;

  // ζούμι/πρέσες editable controls — αλλαγή = αναυπολογισμός & rerender
  document.querySelectorAll(".pumpinp").forEach(inp=>inp.onchange=e=>{
    const lvl=e.target.dataset.lvl; const v=Math.max(0,parseInt(e.target.value)||0);
    state.levelCasting[lvl]=state.levelCasting[lvl]||{};
    state.levelCasting[lvl].pumps=v;
    recomputeWaste(); renderResults();
  });
  document.querySelectorAll(".castmode").forEach(sel=>sel.onchange=e=>{
    const lvl=e.target.dataset.lvl; const mode=e.target.value;
    state.levelCasting[lvl]=state.levelCasting[lvl]||{};
    state.levelCasting[lvl].mode=mode;
    // Κουστούμι: ενδεικτικά +1 πρέσα λόγω διακοπών σκυροδέτησης, αν δεν έχει οριστεί χειροκίνητα
    renderResults();
  });
}

// Ξαναϋπολογίζει μόνο τα ζούμι/πρέσες χωρίς να ξανατρέξει όλη η προμέτρηση
function recomputeWaste(){
  if(!state.results) return;
  Object.values(state.results.levels).forEach(L=>{
    const net=L.netConcrete!=null?L.netConcrete:Object.values(L.beton).reduce((a,b)=>a+b.vol,0);
    const cfg=state.levelCasting[L.name]||{};
    const pumps=(cfg.pumps!=null)?cfg.pumps:Math.max(1,Math.ceil(net/(state.defaultLoad||8)));
    L.netConcrete=net; L.pumps=pumps; L.waste=pumps*(state.pumpWaste||0);
    L.grossConcrete=net+L.waste; L.castMode=cfg.mode||"mono";
  });
}

function renderComparison(){
  const S=state.study, R=state.results;
  // match levels by normalised name (στάθμη number vs DXF level text)
  let h=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
    Έλεγχος μελέτης vs σχεδίων (μπετόν)</h3>
    <p class="note" style="margin-top:0">Σύγκριση όγκου σκυροδέματος του τεύχους με την προμέτρηση από τα DXF, ανά στάθμη.</p>
    <table class="tbl"><thead><tr><th>Στάθμη</th>
    <th class="num">Τεύχος (m³)</th><th class="num">Σχέδια DXF (m³)</th>
    <th class="num">Διαφορά (m³)</th><th class="num">Απόκλιση</th></tr></thead><tbody>`;
  let tS=0,tD=0;
  S.levels.forEach(L=>{
    const dxfLvl=matchLevel(L.level,R.levels);
    const dv=dxfLvl?Object.values(dxfLvl.beton).reduce((a,b)=>a+b.vol,0):null;
    tS+=L.concrete; if(dv!=null) tD+=dv;
    const diff=dv!=null?dv-L.concrete:null;
    const pct=dv!=null&&L.concrete?diff/L.concrete*100:null;
    const col=pct==null?"":Math.abs(pct)>10?"color:var(--warn)":"color:var(--ok)";
    h+=`<tr><td>όροφος ${L.level}</td>
      <td class="num">${fmt(L.concrete)}</td>
      <td class="num">${dv!=null?fmt(dv):"—"}</td>
      <td class="num">${diff!=null?fmt(diff):"—"}</td>
      <td class="num" style="${col}">${pct!=null?(pct>0?"+":"")+fmt(pct,1)+"%":"—"}</td></tr>`;
  });
  const tdiff=tD-tS, tpct=tS?tdiff/tS*100:0;
  h+=`<tr class="totrow"><td>ΣΥΝΟΛΟ</td><td class="num">${fmt(tS)}</td>
    <td class="num">${fmt(tD)}</td><td class="num">${fmt(tdiff)}</td>
    <td class="num">${(tpct>0?"+":"")+fmt(tpct,1)}%</td></tr></tbody></table>`;
  return h;
}
function matchLevel(studyLvl,dxfLevels){
  // studyLvl like "-1","0","1"; dxf level text like "Υπόγειο","Ισόγειο","Α' Όροφος"
  const map={"-1":/υπογ|θεμελ|-1/i,"0":/ισογ|πυλωτ|^0$|ground/i,"1":/α.?οροφ|1ος|^1$|first/i,"2":/β.?οροφ|2ος|^2$/i};
  const rx=map[studyLvl];
  for(const L of dxfLevels){ if(rx&&rx.test(L.name)) return L; if(L.name.trim()===studyLvl) return L; }
  return null;
}

function renderDxfResults(){
  const Ls=Object.values(state.results.levels);
  let totNet=0,totWaste=0,totGross=0,totSteel=0;
  Ls.forEach(L=>{
    totNet+=L.netConcrete||0; totWaste+=L.waste||0; totGross+=L.grossConcrete||0;
    totSteel+=L.steelTotal;
    if(L.steelTotal===0) Object.values(L.beton).forEach(b=>totSteel+=b.steelKg);});

  let html=`<h1 class="h1" style="margin-top:30px">Προμέτρηση από σχέδια (DXF)</h1>
    <p class="sub">${Ls.length} στάθμες · παραδοχές μελέτης ενεργές · ζούμι ${fmt(state.pumpWaste)} m³/πρέσα</p>
    <div class="cards">
      <div class="card b"><div class="k"><span class="pill beton"></span>Καθαρό μπετόν</div>
        <div class="v">${fmt(totNet)} <span class="u">m³</span></div></div>
      <div class="card" style="border-top:3px solid var(--warn)"><div class="k">Ζούμι / πρέσες</div>
        <div class="v">${fmt(totWaste)} <span class="u">m³</span></div></div>
      <div class="card b"><div class="k"><span class="pill beton"></span>Σύνολο παραγγελίας</div>
        <div class="v">${fmt(totGross)} <span class="u">m³</span></div></div>
      <div class="card s"><div class="k"><span class="pill steel"></span>Οπλισμός</div>
        <div class="v">${fmt(totSteel,0)} <span class="u">kg</span></div></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:18px">
      <button class="btn sm" id="expXls">⬇ Excel</button>
      <button class="btn sm ghost" id="expPdf">⬇ PDF</button>
    </div>`;

  // ---- Σκυροδέτηση ανά στάθμη (ζούμι/πρέσες) — editable ----
  html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
    Σκυροδέτηση ανά στάθμη</h3>
    <table class="tbl"><thead><tr><th>Στάθμη</th><th>Τρόπος</th>
    <th class="num">Πρέσες</th><th class="num">Καθαρό (m³)</th>
    <th class="num">Ζούμι (m³)</th><th class="num">Παραγγελία (m³)</th></tr></thead><tbody>`;
  Ls.forEach((L,i)=>{
    html+=`<tr><td>${L.name}</td>
      <td><select class="role castmode" data-lvl="${L.name}">
        <option value="mono" ${L.castMode==="mono"?"selected":""}>Μονολιθικά</option>
        <option value="kostoumi" ${L.castMode==="kostoumi"?"selected":""}>Κουστούμι</option>
      </select></td>
      <td class="num"><input class="pumpinp" data-lvl="${L.name}" type="number" min="0" step="1"
        value="${L.pumps}" style="width:64px;text-align:right;background:var(--panel);
        border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:5px 7px;font-family:var(--mono)"></td>
      <td class="num">${fmt(L.netConcrete)}</td>
      <td class="num" style="color:var(--warn)">+${fmt(L.waste)}</td>
      <td class="num"><b>${fmt(L.grossConcrete)}</b></td></tr>`;
  });
  html+=`<tr class="totrow"><td>ΣΥΝΟΛΟ</td><td></td>
    <td class="num">${Ls.reduce((a,L)=>a+(L.pumps||0),0)}</td>
    <td class="num">${fmt(totNet)}</td><td class="num">+${fmt(totWaste)}</td>
    <td class="num">${fmt(totGross)}</td></tr></tbody></table>
    <p class="note" style="margin-top:0">Κάθε πρέσα κρατάει ${fmt(state.pumpWaste)} m³ (ζούμι) — μη ανακτήσιμο. Το πλήθος πρεσών εκτιμάται αυτόματα (≈${state.defaultLoad} m³/πρέσα)· διόρθωσέ το χειροκίνητα. Το «Κουστούμι» συνεπάγεται περισσότερες σκυροδετήσεις άρα συνήθως περισσότερες πρέσες.</p>`;

  html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
    <span class="pill beton"></span>Σκυρόδεμα ανά στοιχείο</h3>
    <table class="tbl"><thead><tr>
      <th>Στοιχείο</th><th class="num">Εμβαδόν/Μήκος</th><th class="num">Πάχος/Ύψος (m)</th>
      <th class="num">Όγκος (m³)</th><th class="num">Οπλ. παραδοχής (kg)</th></tr></thead><tbody>`;
  Ls.forEach(L=>{
    const items=Object.values(L.beton); if(!items.length) return;
    let lv=0,lk=0;
    html+=`<tr class="lvlhead"><td colspan="5">▸ ${L.name}</td></tr>`;
    items.forEach(b=>{
      const rc=state.beton.find(x=>x.role===b.role);
      const measure=rc&&rc.type==="length"?`${fmt(b.len)} m`:`${fmt(b.area)} m²`;
      html+=`<tr><td>${b.role}</td><td class="num">${measure}</td>
        <td class="num">${fmt(rc?rc.thick:0)}</td><td class="num">${fmt(b.vol)}</td>
        <td class="num">${fmt(b.steelKg,0)}</td></tr>`;
      lv+=b.vol;lk+=b.steelKg;
    });
    html+=`<tr class="totrow"><td>Καθαρό ${L.name}</td><td></td><td></td>
      <td class="num">${fmt(lv)}</td><td class="num">${fmt(lk,0)}</td></tr>`;
  });
  html+=`<tr class="totrow"><td>ΚΑΘΑΡΟ ΣΥΝΟΛΟ</td><td></td><td></td>
    <td class="num">${fmt(totNet)}</td><td class="num">—</td></tr></tbody></table>`;

  const hasExplicit=Ls.some(L=>Object.keys(L.steelByDia).length);
  if(hasExplicit){
    html+=`<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)">
      <span class="pill steel"></span>Οπλισμός — από entities DXF</h3>
      <table class="tbl"><thead><tr><th>Διάμετρος</th><th class="num">Μήκος (m)</th>
      <th class="num">kg/m</th><th class="num">Βάρος (kg)</th></tr></thead><tbody>`;
    Ls.forEach(L=>{
      const dd=Object.entries(L.steelByDia); if(!dd.length)return;
      html+=`<tr class="lvlhead"><td colspan="4">▸ ${L.name}</td></tr>`; let lk=0;
      dd.forEach(([d,s])=>{html+=`<tr><td>${d}</td><td class="num">${fmt(s.len)}</td>
        <td class="num">${fmt(s.kgm,3)}</td><td class="num">${fmt(s.kg,0)}</td></tr>`;lk+=s.kg;});
      html+=`<tr class="totrow"><td>Σύνολο ${L.name}</td><td></td><td></td><td class="num">${fmt(lk,0)}</td></tr>`;
    });
    html+=`</tbody></table>`;
  } else {
    html+=`<p class="note">Δεν εντοπίστηκαν layers οπλισμού στα DXF — ο σίδηρος υπολογίστηκε με τους συντελεστές kg/m³ της μελέτης.</p>`;
  }
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
function buildRows(){
  const rows=[["Στάθμη","Στοιχείο","Μέτρηση","Μονάδα","Πάχος/Ύψος (m)","Όγκος μπετόν (m³)","Οπλισμός (kg)"]];
  Object.values(state.results.levels).forEach(L=>{
    Object.values(L.beton).forEach(b=>{
      const rc=state.beton.find(x=>x.role===b.role);
      const isLen=rc&&rc.type==="length";
      rows.push([L.name,b.role,Number((isLen?b.len:b.area).toFixed(2)),isLen?"m":"m²",
        rc?rc.thick:0,Number(b.vol.toFixed(3)),Number(b.steelKg.toFixed(1))]);
    });
    Object.entries(L.steelByDia).forEach(([d,s])=>{
      rows.push([L.name,"ΟΠΛΙΣΜΟΣ "+d,Number(s.len.toFixed(2)),"m","",
        "",Number(s.kg.toFixed(1))]);
    });
  });
  // casting / ζούμι summary
  rows.push([]);
  rows.push(["ΣΚΥΡΟΔΕΤΗΣΗ ΑΝΑ ΣΤΑΘΜΗ","Τρόπος","Πρέσες","Καθαρό (m³)","Ζούμι (m³)","Παραγγελία (m³)",""]);
  let tN=0,tW=0,tG=0,tP=0;
  Object.values(state.results.levels).forEach(L=>{
    rows.push([L.name, L.castMode==="kostoumi"?"Κουστούμι":"Μονολιθικά", L.pumps,
      Number((L.netConcrete||0).toFixed(2)), Number((L.waste||0).toFixed(2)),
      Number((L.grossConcrete||0).toFixed(2)), ""]);
    tN+=L.netConcrete||0; tW+=L.waste||0; tG+=L.grossConcrete||0; tP+=L.pumps||0;
  });
  rows.push(["ΣΥΝΟΛΟ","",tP,Number(tN.toFixed(2)),Number(tW.toFixed(2)),Number(tG.toFixed(2)),""]);
  return rows;
}
function exportXlsx(){
  const rows=buildRows();
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"]=[{wch:16},{wch:20},{wch:12},{wch:8},{wch:14},{wch:18},{wch:16}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Προμέτρηση");
  XLSX.writeFile(wb,"prometrisi.xlsx");
}
function exportPdf(){
  const {jsPDF}=window.jspdf;const doc=new jsPDF({orientation:"landscape"});
  doc.setFontSize(15);doc.text("Prometrisi - Beton & Oplismos ana Stathmi",14,16);
  const rows=buildRows();
  doc.autoTable({head:[rows[0]],body:rows.slice(1),startY:24,styles:{fontSize:8},
    headStyles:{fillColor:[217,140,43]}});
  doc.save("prometrisi.pdf");
}

/* ---------- init ---------- */
renderBetonTbl();renderRebarTbl();

// Προειδοποίηση αν δεν φόρτωσαν οι βιβλιοθήκες CDN
if (window.__cdnFail || typeof DxfParser==="undefined") {
  setTimeout(()=>toast("Κάποιες βιβλιοθήκες δεν φόρτωσαν (CDN). Έλεγξε σύνδεση & κάνε ανανέωση.",true), 400);
}

// ζούμι/πρέσες global settings
const pw=$("#pumpWaste"), dl=$("#defaultLoad");
if(pw) pw.onchange=e=>{ state.pumpWaste=Math.max(0,parseFloat(e.target.value)||0);
  if(state.results){recomputeWaste();renderResults();} };
if(dl) dl.onchange=e=>{ state.defaultLoad=Math.max(1,parseFloat(e.target.value)||8);
  if(state.results){recomputeWaste();renderResults();} };
