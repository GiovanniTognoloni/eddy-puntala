/* =========================================================================
   EDDY a PUNTA ALA  -  platform esplorativo a livelli.
   Livello 1: Pineta -> Dune -> Spiaggia -> Mare (raccogli regali, salta funghi)
   Livello 2: Macchia Mediterranea (verdure power-up stile Pac-Man,
              volpe inseguitrice, cespugli-nascondiglio)
   Grafica pixel-art originale su canvas. Fisica: salto velocita'+gravita',
   collisioni AABB, movimento deltaTime.
   ========================================================================= */
'use strict';

// ----------------------------- costanti globali -----------------------------
const VIEW_W = 900, VIEW_H = 420;
const GRAV = 0.62;
const JUMP_V = -11.8;
const MOVE_ACC = 0.9;
const MOVE_MAX = 4.4;
const FRICTION = 0.80;
const CLIMB_SPEED = 2.4;
const BOUNCE_V = -9.5;

const rnd = (a, b) => Math.random() * (b - a) + a;
const rndi = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function aabb(a, b){ return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y; }

// true se la x cade dentro una fossa (passaggio sotterraneo) del livello
function inPit(x){
  if (!currentLevel.pits) return false;
  for (const p of currentLevel.pits) if (x > p.x0 && x < p.x1) return true;
  return false;
}

// scala piu' vicina ad una x (per far scendere la volpe nelle grotte)
function nearestLadder(x){
  let best=null, bd=Infinity;
  for (const L of ladders){ const d=Math.abs((L.x+L.w/2)-x); if (d<bd){ bd=d; best=L; } }
  return { ladder:best, dist:bd };
}

// superficie calpestabile effettiva ad una x: il terreno normale, oppure
// (se sopra una fossa) il pavimento della piattaforma piu' in alto sotto quel
// punto. Serve a far camminare nemici (volpe) nelle grotte senza farli cadere.
function surfaceAt(x){
  const g = currentLevel.ground(x);
  if (g <= VIEW_H) return g;                 // terreno solido normale
  let best = VIEW_H + 200;                    // dentro una fossa: cerca un pavimento
  for (const p of platforms){
    if (x >= p.x && x <= p.x + p.w && p.y < best) best = p.y;
  }
  return best;
}

// ----------------------------- AUDIO ----------------------------------------
const Sfx = (() => {
  let ac = null, muted = false;
  const ensure = () => { if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)(); return ac; };
  function play(notes, type='square', vol=0.09){
    if (muted) return;
    try{
      const c = ensure(); let t = c.currentTime;
      for (const [f, d] of notes){
        const o = c.createOscillator(), g = c.createGain();
        o.type = type; o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g); g.connect(c.destination);
        o.start(t); o.stop(t + d); t += d;
      }
    }catch(e){}
  }
  return {
    unlock: ensure,
    setMuted: (v) => { muted = v; }, isMuted: () => muted,
    coin:  () => play([[988,0.07],[1319,0.18]], 'square', 0.08),
    gift:  () => play([[784,0.06],[988,0.06],[1319,0.16]], 'square', 0.08),
    star:  () => play([[1047,0.06],[1319,0.06],[1568,0.06],[2093,0.2]], 'square', 0.08),
    veg:   () => play([[523,0.06],[784,0.06],[1047,0.06],[1319,0.14]], 'square', 0.09), // power-up
    stomp: () => play([[523,0.05],[392,0.08]], 'square', 0.10),
    stompBig: () => play([[392,0.06],[262,0.12]], 'sawtooth', 0.11),
    jump:  () => play([[392,0.05],[659,0.07]], 'square', 0.06),
    foxBark: () => play([[220,0.05],[180,0.08]], 'sawtooth', 0.07),   // verso volpe
    win:   () => play([[523,0.12],[659,0.12],[784,0.12],[1047,0.3]], 'square', 0.09),
    hurt:  () => play([[330,0.1],[247,0.1],[165,0.25]], 'sawtooth', 0.09),
  };
})();

// -------------------- tipi di regalo (valori diversi) -----------------------
const GIFT_TYPES = {
  acorn:      { value: 100, color:'#d99a2b', label:'+100', sfx:'coin' },
  pinecone:   { value: 150, color:'#8a5a2b', label:'+150', sfx:'gift' },
  strawberry: { value: 200, color:'#e8413a', label:'+200', sfx:'gift' },
  star:       { value: 500, color:'#ffd43b', label:'+500', sfx:'star' },
};
// verdure power-up (livello 2): valgono punti E danno la "forza"
const VEG_TYPES = {
  carrot:   { value: 120, color:'#ff8c2b', label:'+120' },
  pepper:   { value: 120, color:'#e23b2b', label:'+120' },
  broccoli: { value: 120, color:'#3a9d3f', label:'+120' },
};
const POWER_MS = 5000;   // durata potenziamento (stile Pac-Man)

// ----------------------------- collezioni -----------------------------------
const popups    = [];
const particles = [];
const clouds    = [];
const platforms = [];   // {x,y,w,h, leafy|sand|rock, moving?, baseX?,range?,phase?,spd?}
const pines     = [];
const mushrooms = [];
const treasures = [];
const chests    = [];
const gulls     = [];
const veggies   = [];   // {x,y,got,bob,type}
const bushes    = [];   // {x,y,w,h}  nascondigli
const foxes     = [];   // volpi inseguitrici
const ladders   = [];   // scale {x,yTop,yBot,w}  (accesso/risalita grotte)
let   fox        = null; // riferimento alla prima volpe (compat.)

function addPopup(x,y,text,color){ popups.push({ x,y,text,color:color||'#fff',life:900,maxLife:900 }); }
function burst(x,y,color,n){ for(let i=0;i<n;i++) particles.push({ x,y,vx:rnd(-2.6,2.6),vy:rnd(-4,-0.5),life:rnd(350,650),color,size:rndi(2,4) }); }

// ======================= DEFINIZIONE LIVELLI ================================
// Ogni livello ha: width, goalX, zone[] e una funzione di terreno + popolamento.
const LEVELS = {
  1: {
    name: 'LIV 1 · PINETA → MARE',
    width: 4200, goalX: 4080,
    zones: [ {name:'PINETA',to:1400},{name:'DUNE',to:2500},{name:'SPIAGGIA',to:3500},{name:'MARE',to:4200} ],
    ground(x){
      if (x < 1400) return 330;
      if (x < 2500){ const t=(x-1400)/1100; return 330 + Math.sin(t*Math.PI*3)*18 + t*10; }
      return 352;
    },
    groundColors(wx){
      if (wx<1400) return ['#58b24a','#6b4a2b'];
      if (wx<2500) return ['#f2d479','#d9b24c'];
      if (wx<3500) return ['#f6e3a0','#e3c96a'];
      return ['#2aa5d6','#1b7fb0'];
    },
    hasSea: 3500,
    build(){
      const G = this.ground.bind(this);
      function addMush(mx, big){
        const h=big?44:26, w=big?52:30;
        mushrooms.push({ x:mx,y:G(mx)-h,w,h,dir:Math.random()<.5?-1:1,alive:true,squashT:0,big:!!big,homeMin:mx-(big?60:75),homeMax:mx+(big?60:75) });
      }
      const pineXs=[260,520,760,1040,1260];
      const giftOnTop=['acorn','pinecone','acorn','strawberry','pinecone'];
      pineXs.forEach((px,i)=>{
        const base=G(px), h=rndi(160,230);
        pines.push({ x:px,baseY:base,h,w:26,lean:rnd(-0.12,0.12) });
        platforms.push({ x:px-40,y:base-h-4,w:100,h:14,leafy:true });
        treasures.push({ x:px+6,y:base-h-30,got:false,bob:rnd(0,6.28),type:giftOnTop[i] });
      });
      treasures.push({ x:160,y:G(160)-26,got:false,bob:rnd(0,6.28),type:'acorn' });
      treasures.push({ x:640,y:G(640)-26,got:false,bob:rnd(0,6.28),type:'strawberry' });
      treasures.push({ x:980,y:G(980)-26,got:false,bob:rnd(0,6.28),type:'acorn' });
      addMush(400); addMush(1100); addMush(1300); addMush(830,true);
      // percorso segreto -> forziere
      [{x:1500,top:250},{x:1600,top:200},{x:1700,top:155}].forEach(jp=>platforms.push({ x:jp.x,y:jp.top,w:70,h:12,leafy:true }));
      chests.push({ x:1716,y:118,w:40,h:30,open:false,bob:rnd(0,6.28),value:1000 });
      // dune mobili
      let dx=1820;
      for(let i=0;i<4;i++){ const y=250-i*6+(i%2?16:0);
        platforms.push({ x:dx,y,w:110,h:16,sand:true,moving:true,baseX:dx,range:60,spd:0.6+i*0.12,phase:rnd(0,6.28) });
        treasures.push({ x:dx+50,y:y-30,got:false,bob:rnd(0,6.28),type:i===2?'star':'pinecone' }); dx+=240; }
      addMush(2000); addMush(2300,true);
      const beachGifts=['acorn','strawberry','pinecone','star'];
      [2620,2820,3050,3300].forEach((tx,i)=>treasures.push({ x:tx,y:G(tx)-26,got:false,bob:rnd(0,6.28),type:beachGifts[i] }));
      addMush(2700); addMush(3150,true);
    },
  },

  2: {
    name: 'LIV 2 · MACCHIA MEDITERRANEA',
    width: 4600, goalX: 4480,
    zones: [ {name:'MACCHIA',to:1300},{name:'GROTTE',to:2600},{name:'ROCCE',to:3600},{name:'RADURA',to:4600} ],
    // aperture nel terreno (passaggi sotterranei): dove x e' dentro un pit,
    // il terreno "sparisce" (ritorna molto in basso) cosi' Eddy puo' scendere.
    pits: [ {x0:700,x1:860}, {x0:1500,x1:1680}, {x0:3000,x1:3160} ],
    ground(x){
      for (const p of this.pits) if (x>p.x0 && x<p.x1) return VIEW_H + 80;  // buco
      if (x < 1300) return 336;
      if (x < 2600){ const t=(x-1300)/1300; return 336 - Math.sin(t*Math.PI*2)*8; }
      if (x < 3600){ const t=(x-2600)/1000; return 336 - Math.sin(t*Math.PI*3)*14; }
      return 340;
    },
    groundColors(wx){
      if (wx<1300) return ['#4e9d3a','#5c3b22'];      // macchia verde
      if (wx<2600) return ['#7a6a52','#4a3c2a'];      // terra/grotte
      if (wx<3600) return ['#9aa0a6','#5a5f66'];      // rocce grigie
      return ['#6fbf4a','#4a7d2a'];                   // radura
    },
    hasSea: null,
    build(){
      const G = this.ground.bind(this);
      function addMush(mx, big){
        const h=big?44:26, w=big?52:30;
        mushrooms.push({ x:mx,y:G(mx)-h,w,h,dir:Math.random()<.5?-1:1,alive:true,squashT:0,big:!!big,homeMin:mx-(big?60:75),homeMax:mx+(big?60:75) });
      }
      const addGift=(x,y,type)=>treasures.push({ x,y,got:false,bob:rnd(0,6.28),type });
      const rockRow=(x,y,n,step,dir)=>{ for(let i=0;i<n;i++) platforms.push({ x:x+i*step*(dir||1), y:y-i*28, w:72, h:14, rock:true }); };

      // --- pini sparsi (arrampicabili) ---
      [360, 1150, 3850].forEach(px=>{ const base=G(px),h=rndi(150,200);
        pines.push({ x:px,baseY:base,h,w:26,lean:rnd(-0.1,0.1) });
        platforms.push({ x:px-40,y:base-h-4,w:100,h:14,leafy:true });
        addGift(px+6, base-h-30, 'pinecone');
      });

      // =========== PERCORSO IN ALTO (macchia): salti di piattaforma ===========
      platforms.push({ x:420,  y:260, w:80, h:14, rock:true });
      platforms.push({ x:540,  y:214, w:80, h:14, rock:true });
      platforms.push({ x:470,  y:166, w:70, h:14, leafy:true });
      addGift(500, 138, 'strawberry');
      addGift(560, 198, 'acorn');

      // =========== PASSAGGI SOTTERRANEI (grotte sotto le fosse) ===========
      // Ogni pit ha una camera: pavimento di roccia + regali + un fungo.
      // pit 1 @700-860
      platforms.push({ x:680, y:392, w:210, h:16, rock:true });   // pavimento grotta 1
      addGift(720, 364, 'acorn'); addGift(770, 364, 'strawberry'); addGift(820, 364, 'star');
      ladders.push({ x:858, yTop:G(900)-6, yBot:392, w:20 });     // scala di risalita
      // pit 2 @1500-1680 (grotta piu' profonda con verdura!)
      platforms.push({ x:1480, y:400, w:230, h:16, rock:true });  // pavimento grotta 2
      addGift(1520, 372, 'acorn'); addGift(1640, 372, 'acorn');
      veggies.push({ x:1580, y:360, got:false, bob:rnd(0,6.28), type:'carrot' });  // VERDURA nascosta sottoterra
      ladders.push({ x:1490, yTop:G(1450)-6, yBot:400, w:20 });   // scala lato sinistro
      ladders.push({ x:1684, yTop:G(1700)-6, yBot:400, w:20 });   // scala lato destro
      // pit 3 @3000-3160
      platforms.push({ x:2980, y:396, w:200, h:16, rock:true });  // pavimento grotta 3
      addGift(3020, 368, 'strawberry'); addGift(3090, 368, 'acorn');
      ladders.push({ x:3158, yTop:G(3200)-6, yBot:396, w:20 });   // scala di risalita

      // =========== ZONA ROCCE: torri + percorso ===========
      rockRow(1850, 300, 3, 110, 1);        // scaletta a salire
      addGift(1890, 266, 'acorn');
      platforms.push({ x:2250, y:250, w:90, h:16, rock:true });
      platforms.push({ x:2430, y:210, w:90, h:16, rock:true });
      addGift(2470, 182, 'strawberry');
      // torre con VERDURA in cima (difficile)
      platforms.push({ x:2700, y:300, w:70, h:14, rock:true });
      platforms.push({ x:2800, y:250, w:66, h:14, rock:true });
      platforms.push({ x:2900, y:198, w:62, h:14, rock:true });
      veggies.push({ x:2922, y:168, got:false, bob:rnd(0,6.28), type:'broccoli' });

      // =========== RADURA finale: ponte di piattaforme in alto + regali ===========
      platforms.push({ x:3700, y:280, w:90, h:14, leafy:true });
      platforms.push({ x:3860, y:240, w:90, h:14, leafy:true });
      platforms.push({ x:4020, y:280, w:90, h:14, leafy:true });
      addGift(3740, 252, 'acorn'); addGift(3900, 212, 'star'); addGift(4060, 252, 'strawberry');

      // regali a terra lungo il cammino
      [260,1050,2150,3400,4250].forEach((tx,i)=>addGift(tx, G(tx)-26, ['acorn','strawberry','acorn','strawberry','pinecone'][i]));

      // =========== CESPUGLI nascondiglio (sparsi vicino ai pericoli) ===========
      bushes.push({ x:560,  y:G(560)-30,  w:70, h:30 });
      bushes.push({ x:1250, y:G(1250)-30, w:80, h:30 });
      bushes.push({ x:2150, y:G(2150)-30, w:76, h:30 });
      bushes.push({ x:3400, y:G(3400)-30, w:80, h:30 });
      bushes.push({ x:4150, y:G(4150)-30, w:76, h:30 });

      // =========== FUNGHI (tanti, misti) ===========
      addMush(950); addMush(1180,true); addMush(2000); addMush(2350,true);
      addMush(2750); addMush(3450,true); addMush(3900); addMush(4300);

      // =========== DUE VOLPI inseguitrici (in zone diverse) ===========
      foxes.push({ x:1000, y:G(1000)-30, w:46, h:30, active:false, timer:0, cooldown:2500, vx:0, stun:0, facing:-1, homeX:1000, speed:3.0, edgeWait:0, descending:null, climbY:0 });
      foxes.push({ x:3550, y:G(3550)-30, w:46, h:30, active:false, timer:0, cooldown:3500, vx:0, stun:0, facing:-1, homeX:3550, speed:3.2, edgeWait:0, descending:null, climbY:0 });
      fox = foxes[0];   // compat.

      // nuvole + gabbiani per vivacizzare il cielo
      for(let i=0;i<9;i++) clouds.push({ x:rnd(0,this.width),y:rnd(30,150),s:rnd(0.8,1.7),spd:rnd(0.1,0.3) });
      for(let i=0;i<6;i++) gulls.push({ x:rnd(0,this.width),y:rnd(40,150),spd:rnd(0.3,0.7),flap:rnd(0,6.28),amp:rnd(6,14) });
    },
  },
};

// ============================= EDDY =========================================
const eddy = {
  x: 60, y: 0, w: 30, h: 42, vx: 0, vy: 0,
  onGround:false, climbing:false, facing:1, jumping:false,
  runFrame:0, runT:0, climbT:0, climbFrame:0,
  dead:false, win:false, power:0, hidden:false,
  reset(){
    this.x=60; this.y=currentLevel.ground(60)-this.h; this.vx=0; this.vy=0;
    this.onGround=true; this.climbing=false; this.facing=1; this.jumping=false;
    this.dead=false; this.win=false; this.power=0; this.hidden=false; this.climbFrame=0;
  }
};

// =========================== STATO DI GIOCO =================================
const game = { cam:0, levelNum:1, state:'menu', over:false, won:false, score:0, got:0, total:0, raf:0 };
let currentLevel = LEVELS[1];
const keys = {};

// elementi DOM
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('overlay');
const treasureTxt = document.getElementById('treasureTxt');
const scoreTxt = document.getElementById('scoreTxt');
const zoneTxt = document.getElementById('zoneTxt');
const levelTxt = document.getElementById('levelTxt');
const muteBtn = document.getElementById('muteBtn');

// ----------------------------- input ----------------------------------------
document.addEventListener('keydown', (e)=>{
  const k = e.key.toLowerCase();
  if (['arrowleft','arrowright','arrowup','arrowdown',' '].includes(k)) e.preventDefault();
  keys[k] = true; Sfx.unlock();
  if (k==='escape'){ showMenu(); return; }
  if (game.state==='menu'){
    if (k==='1'){ startLevel(1); return; }
    if (k==='2'){ startLevel(2); return; }
    if (k===' '||k==='arrowup'||k==='w'){ startLevel(game.levelNum); return; }
  } else {
    if ((k===' '||k==='arrowup'||k==='w') && game.over){ startLevel(game.levelNum); }
    if (k==='r') startLevel(game.levelNum);
  }
  if (k==='m') toggleMute();
});
document.addEventListener('keyup', (e)=>{ keys[e.key.toLowerCase()] = false; });
canvas.addEventListener('pointerdown', ()=>{ if(game.state==='menu') startLevel(game.levelNum); else if(game.over) startLevel(game.levelNum); });
if (muteBtn) muteBtn.addEventListener('click', (e)=>{ e.stopPropagation(); toggleMute(); });

function toggleMute(){ const m=!Sfx.isMuted(); Sfx.setMuted(m); if(muteBtn) muteBtn.textContent=m?'🔇':'🔊'; }

// ----------------------------- menu / avvio ---------------------------------
function showMenu(){
  game.state='menu'; game.over=false;
  if (game.raf) cancelAnimationFrame(game.raf);
  overlay.innerHTML =
    '<div class="big">🐿️ EDDY a PUNTA ALA</div>' +
    '<div class="sub">Scegli un livello</div>' +
    '<div class="levels">' +
      '<button class="lvlbtn" data-lvl="1">▶ LIVELLO 1<small>Pineta → Mare · regali, funghi, forziere</small></button>' +
      '<button class="lvlbtn" data-lvl="2">▶ LIVELLO 2<small>Macchia · verdure, volpe, nascondigli</small></button>' +
    '</div>' +
    '<div class="sub blink">Premi <kbd>1</kbd> o <kbd>2</kbd> (o clicca)</div>';
  overlay.classList.remove('hidden');
  overlay.querySelectorAll('.lvlbtn').forEach(b=>{
    b.addEventListener('click', (e)=>{ e.stopPropagation(); Sfx.unlock(); startLevel(+b.dataset.lvl); });
  });
  // scena statica dietro il menu
  currentLevel = LEVELS[game.levelNum];
  loadLevel(game.levelNum, false);
  draw();
}

function loadLevel(n, resetEddy=true){
  currentLevel = LEVELS[n];
  platforms.length=pines.length=mushrooms.length=treasures.length=gulls.length=0;
  popups.length=particles.length=clouds.length=chests.length=0;
  veggies.length=bushes.length=foxes.length=ladders.length=0; fox=null;
  currentLevel.build();
  if (resetEddy) eddy.reset();
  game.levelNum=n; game.total = treasures.length + chests.length + veggies.length;
  if (levelTxt) levelTxt.textContent = 'LIV '+n;
}

function startLevel(n){
  Sfx.unlock();
  loadLevel(n, true);
  game.cam=0; game.state='play'; game.over=false; game.won=false; game.score=0; game.got=0;
  overlay.classList.add('hidden');
  if (game.raf) cancelAnimationFrame(game.raf);
  last = performance.now(); loop();
}

// ============================ UPDATE ========================================
function zoneAt(x){ for (const z of currentLevel.zones) if (x < z.to) return z.name; return currentLevel.zones.at(-1).name; }

function update(dt){
  if (game.over) return;
  const f = dt/16.67;
  const G = currentLevel.ground.bind(currentLevel);
  const LEVEL_W = currentLevel.width, GOAL_X = currentLevel.goalX;

  // power-up timer
  if (eddy.power > 0){ eddy.power -= dt; if (eddy.power < 0) eddy.power = 0; }
  const powered = eddy.power > 0;
  const curMax = powered ? MOVE_MAX*1.35 : MOVE_MAX;
  const curJump = powered ? JUMP_V*1.12 : JUMP_V;

  // piattaforme mobili
  for (const p of platforms){ if (p.moving){ p.phase += p.spd*0.02*f; p.x = p.baseX + Math.sin(p.phase)*p.range; } }

  // ---- arrampicata ----
  let onPine=null;
  for (const p of pines){ const trunk={x:p.x,y:p.baseY-p.h,w:p.w,h:p.h+10};
    if (aabb({x:eddy.x+6,y:eddy.y,w:eddy.w-12,h:eddy.h},trunk)){ onPine=p; break; } }
  // scale: Eddy puo' salire/scendere se sovrapposto
  let onLadder=null;
  for (const L of ladders){ const lb={x:L.x-2,y:L.yTop-6,w:L.w+4,h:(L.yBot-L.yTop)+20};
    if (aabb({x:eddy.x+6,y:eddy.y,w:eddy.w-12,h:eddy.h},lb)){ onLadder=L; break; } }
  const wantClimb = (keys['arrowup']||keys['w']||keys['arrowdown']||keys['s']);
  if (onPine && wantClimb){
    eddy.climbing=true; eddy.vy=0; eddy.vx=0;
    if (keys['arrowup']||keys['w']) eddy.y -= CLIMB_SPEED*f;
    if (keys['arrowdown']||keys['s']) eddy.y += CLIMB_SPEED*f;
    eddy.y = clamp(eddy.y, onPine.baseY-onPine.h-eddy.h, onPine.baseY-eddy.h);
    eddy.climbT += dt; if (eddy.climbT>140){ eddy.climbFrame^=1; eddy.climbT=0; }
  } else if (onLadder && wantClimb){
    eddy.climbing=true; eddy.vy=0; eddy.vx=0;
    if (keys['arrowup']||keys['w']) eddy.y -= CLIMB_SPEED*f;
    if (keys['arrowdown']||keys['s']) eddy.y += CLIMB_SPEED*f;
    eddy.y = clamp(eddy.y, onLadder.yTop-eddy.h, onLadder.yBot-eddy.h);
    eddy.climbT += dt; if (eddy.climbT>140){ eddy.climbFrame^=1; eddy.climbT=0; }
  } else { eddy.climbing=false; }

  if (!eddy.climbing){
    let moving=false;
    if (keys['arrowleft']||keys['a']){ eddy.vx -= MOVE_ACC*f; eddy.facing=-1; moving=true; }
    if (keys['arrowright']||keys['d']){ eddy.vx += MOVE_ACC*f; eddy.facing=1; moving=true; }
    if (!moving) eddy.vx *= Math.pow(FRICTION,f);
    eddy.vx = clamp(eddy.vx,-curMax,curMax);
    if ((keys[' ']||keys['arrowup']||keys['w']) && eddy.onGround){ eddy.vy=curJump; eddy.onGround=false; eddy.jumping=true; Sfx.jump(); }
    eddy.vy += GRAV*f; eddy.vy = clamp(eddy.vy,-20,16);
    eddy.x += eddy.vx*f; eddy.x = clamp(eddy.x,0,LEVEL_W-eddy.w);
    eddy.y += eddy.vy*f;
    const gy = G(eddy.x+eddy.w/2); eddy.onGround=false;
    if (eddy.y+eddy.h>=gy){ eddy.y=gy-eddy.h; eddy.vy=0; eddy.onGround=true; eddy.jumping=false; }
    for (const p of platforms){ const box={x:p.x,y:p.y,w:p.w,h:p.h};
      if (aabb({x:eddy.x+4,y:eddy.y,w:eddy.w-8,h:eddy.h},box)){
        const prevBottom=eddy.y+eddy.h-eddy.vy*f;
        if (eddy.vy>=0 && prevBottom<=p.y+6){ eddy.y=p.y-eddy.h; eddy.vy=0; eddy.onGround=true; eddy.jumping=false; }
      } }
    if (eddy.onGround && Math.abs(eddy.vx)>0.4){ eddy.runT+=dt; if(eddy.runT>90){ eddy.runFrame^=1; eddy.runT=0; } }
  }

  // ---- nascondiglio: Eddy e' "hidden" se sta fermo dentro un cespuglio ----
  eddy.hidden = false;
  for (const b of bushes){
    if (aabb({x:eddy.x+6,y:eddy.y+10,w:eddy.w-12,h:eddy.h-10}, b) && Math.abs(eddy.vx)<0.6){ eddy.hidden=true; break; }
  }

  // ---- VOLPI inseguitrici ----
  for (const fox of foxes){
    const dist = Math.abs(fox.x - eddy.x);
    if (!fox.active){
      fox.cooldown -= dt;
      // si attiva se Eddy e' abbastanza vicino, non nascosto, e il cooldown e' finito
      if (fox.cooldown<=0 && dist < 420 && !eddy.hidden){ fox.active=true; fox.timer=5000; Sfx.foxBark(); }
      // torna lentamente verso casa quando inattiva (fermandosi ai bordi delle fosse)
      const step = Math.sign(fox.homeX - fox.x) * 0.6 * f;
      if (!(currentLevel.ground(fox.x+fox.w/2)<=VIEW_H && inPit(fox.x+fox.w/2 + Math.sign(step)*(fox.w/2+6)))) fox.x += step;
    } else if (fox.stun > 0){
      // volpe stordita (saltata in testa): ferma per un po'
      fox.stun -= dt; fox.vx *= Math.pow(0.9, f);
      if (fox.stun <= 0){ fox.active=false; fox.cooldown=2500; fox.descending=null; fox.edgeWait=0; }
    } else if (fox.descending){
      // ---- la volpe sta usando una SCALA per scendere nella grotta ----
      const L = fox.descending;
      const lcx = L.x + L.w/2, fcx = fox.x + fox.w/2;
      if (Math.abs(fcx - lcx) > 2){
        fox.x += Math.sign(lcx - fcx) * 1.6 * f;       // allineati alla scala
        fox.facing = (lcx-fcx)<0?-1:1;
      } else {
        fox.climbY += 2.2 * f;                         // scendi lungo la scala
        if (fox.climbY >= (L.yBot - L.yTop)){ fox.descending=null; fox.edgeWait=0; } // arrivata in fondo
      }
    } else {
      fox.timer -= dt;
      if (eddy.hidden) fox.timer -= dt*2;             // se ti nascondi, si stanca prima
      const dir = Math.sign(eddy.x - fox.x) || fox.facing;
      // INERZIA: la volpe accelera gradualmente verso la direzione target,
      // quindi non si gira istantaneamente e si puo' scavalcare con un salto.
      const targetV = dir * fox.speed * (powered?0.65:1);
      fox.vx += (targetV - fox.vx) * 0.06 * f;         // accelerazione dolce
      // la volpe si FERMA sul bordo della fossa (non ci cade dentro)
      const foxOnSolid = currentLevel.ground(fox.x+fox.w/2) <= VIEW_H;
      const eddyBelow  = eddy.y > VIEW_H*0.6;            // Eddy e' sceso in basso (grotta)
      const nextEdge = fox.x + fox.w/2 + Math.sign(fox.vx||dir) * (fox.w/2 + 6);
      if (foxOnSolid && inPit(nextEdge)){
        fox.vx = 0; fox.facing = dir<0?-1:1;           // bloccata al ciglio, ti guarda
        // se Eddy resta sotto, dopo un po' la volpe VA ALLA SCALA e scende
        if (eddyBelow){
          fox.edgeWait += dt;
          if (fox.edgeWait > 1400){
            const nl = nearestLadder(eddy.x);
            if (nl.ladder){ fox.descending = nl.ladder; fox.climbY = 0; fox.edgeWait = 0; Sfx.foxBark(); }
          }
        } else fox.edgeWait = 0;
      } else {
        fox.edgeWait = 0;
        fox.x += fox.vx * f;
        if (Math.abs(fox.vx) > 0.2) fox.facing = fox.vx<0?-1:1;
      }
      if (fox.timer<=0 || dist>650){ fox.active=false; fox.cooldown=3000; }
      // contatto con Eddy
      const fb={x:fox.x,y:fox.y,w:fox.w,h:fox.h}, eb={x:eddy.x+4,y:eddy.y,w:eddy.w-8,h:eddy.h};
      if (!eddy.hidden && aabb(fb,eb)){
        const stomped = eddy.vy > 0 && (eddy.y+eddy.h) < (fox.y + fox.h*0.85);
        if (stomped){ // Eddy le salta in testa -> la stordisce e rimbalza
          fox.stun = 2200; fox.vx = 0; eddy.vy = BOUNCE_V; eddy.onGround=false;
          game.score+=120; addPopup(fox.x+fox.w/2,fox.y,'+120','#ffd43b'); burst(fox.x+fox.w/2,fox.y+fox.h/2,'#e07a2b',14); Sfx.stomp();
        } else if (powered){ // respingi la volpe se potenziato
          fox.active=false; fox.cooldown=3500; fox.vx = -fox.facing*6;
          game.score+=150; addPopup(fox.x+fox.w/2,fox.y,'+150','#ffd43b'); burst(fox.x+fox.w/2,fox.y+fox.h/2,'#e07a2b',16); Sfx.stomp();
        } else {
          hit();
        }
      }
    }
    // posizione verticale: se sta scendendo lungo una scala segue climbY,
    // altrimenti sta sulla superficie calpestabile (terreno o pavimento grotta)
    if (fox.descending){ fox.y = fox.descending.yTop + fox.climbY - fox.h/2; }
    else fox.y = surfaceAt(fox.x+fox.w/2) - fox.h;
  }

  // ---- funghi ----
  for (const m of mushrooms){
    if (!m.alive){ m.squashT -= dt; continue; }
    m.x += m.dir*(m.big?0.6:0.85)*f;
    if (m.x<m.homeMin||m.x>m.homeMax) m.dir*=-1;
    m.y = G(m.x)-m.h;
    const eb={x:eddy.x+4,y:eddy.y,w:eddy.w-8,h:eddy.h}, mb={x:m.x,y:m.y,w:m.w,h:m.h};
    if (aabb(eb,mb)){
      const falling = eddy.vy>0 && (eddy.y+eddy.h)<(m.y+m.h*0.55);
      if (falling || powered){
        m.alive=false; m.squashT=260;
        if (falling){ eddy.vy=BOUNCE_V; eddy.onGround=false; }
        const pts=m.big?100:50; game.score+=pts;
        addPopup(m.x+m.w/2,m.y,'+'+pts,'#ffe14d');
        burst(m.x+m.w/2,m.y+m.h/2,m.big?'#9b2b22':'#d0352b',m.big?18:12);
        burst(m.x+m.w/2,m.y+m.h/2,'#fff',m.big?8:5);
        m.big?Sfx.stompBig():Sfx.stomp();
      } else hit();
    }
  }

  // ---- regali ----
  const eb={x:eddy.x,y:eddy.y,w:eddy.w,h:eddy.h};
  for (const t of treasures){
    if (t.got) continue; t.bob += dt*0.005;
    if (aabb(eb,{x:t.x-4,y:t.y-4,w:26,h:26})){
      t.got=true; game.got++; const g=GIFT_TYPES[t.type]||GIFT_TYPES.acorn; game.score+=g.value;
      addPopup(t.x+8,t.y,g.label,g.color); burst(t.x+8,t.y+8,g.color,8);
      Sfx[g.sfx]?Sfx[g.sfx]():Sfx.coin();
    }
  }

  // ---- verdure power-up ----
  for (const v of veggies){
    if (v.got) continue; v.bob += dt*0.005;
    if (aabb(eb,{x:v.x-4,y:v.y-4,w:26,h:26})){
      v.got=true; game.got++; const vt=VEG_TYPES[v.type]||VEG_TYPES.carrot;
      game.score+=vt.value; eddy.power = POWER_MS;
      addPopup(v.x+8,v.y,'FORZA!',' #ffe14d'); burst(v.x+8,v.y+8,vt.color,14); Sfx.veg();
    }
  }

  // ---- forzieri ----
  for (const c of chests){
    if (c.open) continue; c.bob += dt*0.004;
    if (aabb(eb,{x:c.x,y:c.y,w:c.w,h:c.h})){
      c.open=true; game.got++; game.score+=c.value;
      addPopup(c.x+c.w/2,c.y,'+'+c.value+' 🏆','#ffd43b'); burst(c.x+c.w/2,c.y,'#ffd43b',24); Sfx.star();
    }
  }

  // gabbiani / nuvole / popup / particelle
  for (const g of gulls){ g.x-=g.spd*f; g.flap+=dt*0.012; if(g.x<-40) g.x=LEVEL_W+rnd(0,200); }
  for (const cl of clouds){ cl.x-=cl.spd*f; if(cl.x<-140) cl.x=LEVEL_W+rnd(0,200); }
  for (const pu of popups){ pu.y-=0.35*f; pu.life-=dt; }
  for (let i=popups.length-1;i>=0;i--) if(popups[i].life<=0) popups.splice(i,1);
  for (const p of particles){ p.vy+=0.18*f; p.x+=p.vx*f; p.y+=p.vy*f; p.life-=dt; }
  for (let i=particles.length-1;i>=0;i--) if(particles[i].life<=0) particles.splice(i,1);

  if (eddy.y > VIEW_H+60) hit();
  if (eddy.x + eddy.w >= GOAL_X) winGame();

  game.cam = clamp(eddy.x - VIEW_W*0.4, 0, LEVEL_W - VIEW_W);
  treasureTxt.textContent = game.got+' / '+game.total;
  scoreTxt.textContent = game.score;
  zoneTxt.textContent = zoneAt(eddy.x) + (powered?' ⚡':'' ) + (eddy.hidden?' 🫣':'');
}

function hit(){
  if (game.over) return;
  game.over=true; eddy.dead=true; Sfx.hurt();
  showOverlay('AHIA! 🐾','Eddy e\' stato colpito.','Premi <kbd>R</kbd> per riprovare · <kbd>ESC</kbd> menu');
}
function winGame(){
  if (game.over) return;
  game.over=true; game.won=true; eddy.win=true; Sfx.win();
  const bonus = game.got===game.total ? ' · TUTTO RACCOLTO! 🏆' : '';
  const next = LEVELS[game.levelNum+1]
    ? '<div class="levels"><button class="lvlbtn" data-lvl="'+(game.levelNum+1)+'">▶ LIVELLO '+(game.levelNum+1)+'</button></div>'
    : '';
  overlay.innerHTML =
    '<div class="big">🎉 TRAGUARDO!</div>' +
    '<div class="sub">Livello '+game.levelNum+' · Tesori '+game.got+'/'+game.total+' · Punti '+game.score+bonus+'</div>' +
    next +
    '<div class="sub blink">Premi <kbd>R</kbd> per rigiocare · <kbd>ESC</kbd> menu</div>';
  overlay.classList.remove('hidden');
  overlay.querySelectorAll('.lvlbtn').forEach(b=>b.addEventListener('click',(e)=>{ e.stopPropagation(); Sfx.unlock(); startLevel(+b.dataset.lvl); }));
}
function showOverlay(big,sub,hint){
  overlay.innerHTML='<div class="big">'+big+'</div><div class="sub">'+sub+'</div><div class="sub blink">'+hint+'</div>';
  overlay.classList.remove('hidden');
}

// ============================ DISEGNO =======================================
function draw(){
  ctx.clearRect(0,0,VIEW_W,VIEW_H);
  drawSky();
  for (const cl of clouds) drawCloud(cl);
  for (const g of gulls)   drawGull(g.x-game.cam*0.6, g.y, g.flap);
  drawFarScenery();
  drawGround();
  for (const b of bushes)    drawBush(b, false);  // parte posteriore cespuglio
  for (const p of pines)     drawPine(p);
  for (const L of ladders)   drawLadder(L);
  for (const p of platforms) drawPlatform(p);
  for (const c of chests)    if(!c.open) drawChest(c);
  for (const t of treasures) if(!t.got) drawTreasure(t);
  for (const v of veggies)   if(!v.got) drawVeggie(v);
  for (const m of mushrooms) drawMushroom(m);
  for (const fox of foxes) drawFox(fox);
  drawParticles();
  drawGoal();
  drawEddy();
  for (const b of bushes)    drawBush(b, true);    // fronda davanti (nasconde Eddy)
  drawPopups();
}

function drawSky(){
  const g=ctx.createLinearGradient(0,0,0,VIEW_H);
  g.addColorStop(0,'#8fd3ff'); g.addColorStop(0.6,'#bfeaff'); g.addColorStop(1,'#eaf7ff');
  ctx.fillStyle=g; ctx.fillRect(0,0,VIEW_W,VIEW_H);
  ctx.fillStyle='#fff4b0'; ctx.beginPath(); ctx.arc(VIEW_W-90,70,34,0,6.28); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.5)'; ctx.beginPath(); ctx.arc(VIEW_W-90,70,46,0,6.28); ctx.fill();
}
function drawCloud(cl){
  const sx=cl.x-game.cam*0.4, sy=cl.y, s=cl.s;
  if (sx<-160||sx>VIEW_W+160) return;
  ctx.fillStyle='rgba(255,255,255,.92)';
  const puff=(dx,dy,r)=>{ ctx.beginPath(); ctx.arc(sx+dx*s,sy+dy*s,r*s,0,6.28); ctx.fill(); };
  puff(0,0,18); puff(22,4,22); puff(46,2,16); puff(14,-10,15); puff(34,-8,14);
  ctx.fillStyle='rgba(255,255,255,.6)'; ctx.fillRect(sx-6*s,sy+10*s,64*s,8*s);
}
function drawFarScenery(){
  const off=game.cam*0.3; ctx.fillStyle='#7fb77e';
  for (let i=-1;i<12;i++){ const x=i*180-(off%180); ctx.beginPath(); ctx.moveTo(x,300); ctx.quadraticCurveTo(x+90,220,x+180,300); ctx.fill(); }
  if (currentLevel.hasSea!=null){ const seaX=currentLevel.hasSea-game.cam; if(seaX<VIEW_W){ ctx.fillStyle='#2aa5d6'; ctx.fillRect(Math.max(0,seaX),300,VIEW_W-Math.max(0,seaX),40); } }
}
function drawGround(){
  // interno grotta scuro dietro le fosse (passaggi sotterranei)
  if (currentLevel.pits){
    ctx.fillStyle='#1c1208';
    for (const p of currentLevel.pits){
      const sx0=p.x0-game.cam-20, sw=(p.x1-p.x0)+40;
      if (sx0>VIEW_W || sx0+sw<0) continue;
      ctx.fillRect(sx0, 300, sw, VIEW_H-300);
      // stalattiti
      ctx.fillStyle='#2a1c10';
      for (let x=sx0+10;x<sx0+sw-10;x+=22){ ctx.beginPath(); ctx.moveTo(x,300); ctx.lineTo(x+6,318); ctx.lineTo(x+12,300); ctx.fill(); }
      ctx.fillStyle='#1c1208';
    }
  }
  for (let sx=0; sx<VIEW_W; sx+=4){
    const wx=sx+game.cam, top=currentLevel.ground(wx);
    if (top > VIEW_H) continue;   // dentro una fossa: non disegnare terreno
    const [topCol,botCol]=currentLevel.groundColors(wx);
    ctx.fillStyle=topCol; ctx.fillRect(sx,top,4,8);
    ctx.fillStyle=botCol; ctx.fillRect(sx,top+8,4,VIEW_H-top-8);
  }
  if (currentLevel.hasSea!=null){
    const seaX=currentLevel.hasSea-game.cam;
    if (seaX<VIEW_W){ ctx.fillStyle='rgba(255,255,255,.5)';
      for (let x=Math.max(0,seaX);x<VIEW_W;x+=28){ const yy=352+Math.sin((x+performance.now()*0.05)*0.1)*2; ctx.fillRect(x,yy,14,2); } }
  }
}

function drawPine(p){
  const base=p.x-game.cam; if(base<-140||base>VIEW_W+140) return;
  const topY=p.baseY-p.h, lean=p.lean;
  ctx.fillStyle='#9a6a33'; let prevX=base;
  for (let seg=0; seg<=10; seg++){
    const yy=p.baseY-(p.h*seg/10);
    const xx=base+Math.sin(seg/10*Math.PI)*10+lean*(p.h*seg/10);
    const w=p.w*(1-seg*0.045);
    ctx.fillRect(xx-w/2, yy-p.h/10, w, p.h/10+1); prevX=xx;
  }
  ctx.fillStyle='#6e4420';
  for (let seg=2; seg<10; seg++){ const yy=p.baseY-(p.h*seg/10); const xx=base+Math.sin(seg/10*Math.PI)*10+lean*(p.h*seg/10); ctx.fillRect(xx-6,yy,12,2); }
  const cx=prevX, cy=topY-2;
  ctx.fillStyle='#2e7d32'; ctx.beginPath(); ctx.ellipse(cx,cy,64,20,0,Math.PI,0); ctx.fill(); ctx.fillRect(cx-64,cy,128,10);
  ctx.fillStyle='#3a9d3f'; ctx.beginPath(); ctx.ellipse(cx-22,cy-6,30,14,0,Math.PI,0); ctx.fill(); ctx.beginPath(); ctx.ellipse(cx+24,cy-4,28,13,0,Math.PI,0); ctx.fill();
  ctx.fillStyle='#267a2b'; for (let i=-2;i<=2;i++){ ctx.beginPath(); ctx.ellipse(cx+i*22,cy+9,12,6,0,0,Math.PI); ctx.fill(); }
}
function drawPlatform(p){
  const sx=p.x-game.cam; if(sx<-160||sx>VIEW_W+160) return;
  if (p.leafy){
    ctx.fillStyle='#3a9d3f'; ctx.fillRect(sx,p.y,p.w,p.h);
    ctx.fillStyle='#2e7d32'; ctx.fillRect(sx,p.y+p.h-4,p.w,4);
    ctx.fillStyle='#45b24a'; for(let x=sx+4;x<sx+p.w-4;x+=14){ ctx.beginPath(); ctx.ellipse(x,p.y+2,6,4,0,Math.PI,0); ctx.fill(); }
  } else if (p.sand){
    ctx.fillStyle='#f2d479'; ctx.fillRect(sx,p.y,p.w,p.h);
    ctx.fillStyle='#d9b24c'; ctx.fillRect(sx,p.y+p.h-4,p.w,4);
    ctx.fillStyle='#caa047'; for(let x=sx+6;x<sx+p.w-6;x+=16) ctx.fillRect(x,p.y+3,3,p.h-6);
    if (p.moving){ ctx.fillStyle='rgba(120,80,20,.5)'; ctx.fillRect(sx+2,p.y+p.h/2-1,6,2); ctx.fillRect(sx+p.w-8,p.y+p.h/2-1,6,2); }
  } else if (p.rock){
    ctx.fillStyle='#8a9096'; ctx.fillRect(sx,p.y,p.w,p.h);
    ctx.fillStyle='#6a7076'; ctx.fillRect(sx,p.y+p.h-5,p.w,5);
    ctx.fillStyle='#a2a8ae'; for(let x=sx+5;x<sx+p.w-5;x+=18) ctx.fillRect(x,p.y+3,8,3);
  }
}
function drawTreasure(t){
  const sx=t.x-game.cam, sy=t.y+Math.sin(t.bob)*4; if(sx<-30||sx>VIEW_W+30) return;
  ctx.fillStyle='rgba(255,255,255,.28)'; ctx.beginPath(); ctx.arc(sx+8,sy+8,14,0,6.28); ctx.fill();
  if (t.type==='acorn'){ ctx.fillStyle='#d99a2b'; ctx.fillRect(sx+2,sy+6,14,12); ctx.fillStyle='#b5791b'; ctx.fillRect(sx+2,sy+15,14,3); ctx.fillStyle='#7a4a1e'; ctx.fillRect(sx,sy,18,8); ctx.fillStyle='#5e3714'; ctx.fillRect(sx+7,sy-4,4,4); ctx.fillStyle='#fff6c8'; ctx.fillRect(sx+4,sy+8,3,3); }
  else if (t.type==='pinecone'){ ctx.fillStyle='#8a5a2b'; for(let r=0;r<4;r++){ const w=14-r*2; ctx.fillRect(sx+2+(14-w)/2,sy+2+r*4,w,4); } ctx.fillStyle='#6e4420'; for(let r=0;r<4;r++){ const w=14-r*2; ctx.fillRect(sx+2+(14-w)/2,sy+5+r*4,w,1); } ctx.fillStyle='#4a7d2a'; ctx.fillRect(sx+6,sy-3,3,4); }
  else if (t.type==='strawberry'){ ctx.fillStyle='#e8413a'; ctx.beginPath(); ctx.moveTo(sx+8,sy+20); ctx.quadraticCurveTo(sx-2,sy+6,sx+8,sy+4); ctx.quadraticCurveTo(sx+18,sy+6,sx+8,sy+20); ctx.fill(); ctx.fillStyle='#fff'; for(let i=0;i<5;i++) ctx.fillRect(sx+4+(i%3)*4,sy+8+Math.floor(i/3)*5,1,1); ctx.fillStyle='#3a9d3f'; ctx.fillRect(sx+4,sy+2,8,3); ctx.fillRect(sx+6,sy-1,4,3); }
  else if (t.type==='star'){ ctx.save(); ctx.translate(sx+8,sy+9); ctx.rotate(Math.sin(t.bob)*0.3); ctx.fillStyle='#ffd43b'; ctx.beginPath(); for(let i=0;i<5;i++){ const a=-Math.PI/2+i*2*Math.PI/5; ctx.lineTo(Math.cos(a)*9,Math.sin(a)*9); const a2=a+Math.PI/5; ctx.lineTo(Math.cos(a2)*4,Math.sin(a2)*4); } ctx.closePath(); ctx.fill(); ctx.fillStyle='#fff6c8'; ctx.fillRect(-2,-2,2,2); ctx.restore(); }
}
// VERDURE power-up
function drawVeggie(v){
  const sx=v.x-game.cam, sy=v.y+Math.sin(v.bob)*4; if(sx<-30||sx>VIEW_W+30) return;
  // alone pulsante (power-up)
  const pulse=0.3+0.2*Math.abs(Math.sin(v.bob*2));
  ctx.fillStyle='rgba(255,240,120,'+pulse+')'; ctx.beginPath(); ctx.arc(sx+8,sy+10,15,0,6.28); ctx.fill();
  if (v.type==='carrot'){
    ctx.fillStyle='#ff8c2b'; ctx.beginPath(); ctx.moveTo(sx+8,sy+22); ctx.lineTo(sx+2,sy+6); ctx.lineTo(sx+14,sy+6); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#d96a16'; ctx.fillRect(sx+6,sy+10,2,2); ctx.fillRect(sx+9,sy+14,2,2);
    ctx.fillStyle='#3a9d3f'; ctx.fillRect(sx+5,sy+1,2,6); ctx.fillRect(sx+8,sy-1,2,8); ctx.fillRect(sx+11,sy+1,2,6);
  } else if (v.type==='pepper'){
    ctx.fillStyle='#e23b2b'; ctx.beginPath(); ctx.ellipse(sx+8,sy+13,7,9,0,0,6.28); ctx.fill(); ctx.fillRect(sx+4,sy+16,8,4);
    ctx.fillStyle='#b22a1c'; ctx.fillRect(sx+6,sy+16,2,3);
    ctx.fillStyle='#3a9d3f'; ctx.fillRect(sx+7,sy+2,3,5);
  } else { // broccoli
    ctx.fillStyle='#2e7d32'; ctx.beginPath(); ctx.arc(sx+5,sy+6,4,0,6.28); ctx.arc(sx+11,sy+5,4,0,6.28); ctx.arc(sx+8,sy+9,5,0,6.28); ctx.fill();
    ctx.fillStyle='#8fd88f'; ctx.fillRect(sx+6,sy+12,5,8);
  }
}
function drawChest(c){
  const sx=c.x-game.cam, sy=c.y+Math.sin(c.bob)*3; if(sx<-60||sx>VIEW_W+60) return;
  ctx.fillStyle='rgba(255,220,100,.35)'; ctx.beginPath(); ctx.arc(sx+c.w/2,sy+c.h/2,26,0,6.28); ctx.fill();
  ctx.fillStyle='#8a5a2b'; ctx.fillRect(sx,sy+10,c.w,c.h-10); ctx.fillStyle='#6e4420'; ctx.fillRect(sx,sy+c.h-5,c.w,5);
  ctx.fillStyle='#a06a33'; ctx.beginPath(); ctx.ellipse(sx+c.w/2,sy+10,c.w/2,9,0,Math.PI,0); ctx.fill();
  ctx.fillStyle='#ffd43b'; ctx.fillRect(sx+3,sy+16,c.w-6,3); ctx.fillRect(sx+3,sy+c.h-10,c.w-6,3);
  ctx.fillStyle='#ffe98a'; ctx.fillRect(sx+c.w/2-4,sy+14,8,10); ctx.fillStyle='#3a2412'; ctx.fillRect(sx+c.w/2-1,sy+18,2,4);
}
function drawMushroom(m){
  const sx=m.x-game.cam; if(sx<-60||sx>VIEW_W+60) return;
  if (!m.alive){ const a=clamp(m.squashT/260,0,1); ctx.globalAlpha=a; ctx.fillStyle=m.big?'#9b2b22':'#c0392b'; ctx.fillRect(sx+2,m.y+m.h-7,m.w-4,7); ctx.globalAlpha=1; return; }
  const sy=m.y, big=m.big, W=m.w, H=m.h, stepY=Math.sin(performance.now()*0.01)*2;
  ctx.fillStyle='#f0e2c0'; ctx.fillRect(sx+W*0.3,sy+H*0.46,W*0.4,H*0.5);
  ctx.fillStyle=big?'#a02a1f':'#d0352b'; ctx.beginPath(); ctx.ellipse(sx+W/2,sy+H*0.42,W/2,H*0.42,0,Math.PI,0); ctx.fill(); ctx.fillRect(sx,sy+H*0.38,W,3);
  ctx.fillStyle='#fff'; ctx.fillRect(sx+W*0.18,sy+H*0.12,W*0.13,H*0.12); ctx.fillRect(sx+W*0.62,sy+H*0.18,W*0.13,H*0.12); ctx.fillRect(sx+W*0.4,sy+H*0.30,W*0.1,H*0.1);
  ctx.fillStyle='#3a2a1a'; const eyY=sy+H*0.56; ctx.fillRect(sx+W*0.34,eyY,W*0.1,H*0.14); ctx.fillRect(sx+W*0.56,eyY,W*0.1,H*0.14);
  if (big){ ctx.fillStyle='#5a1a12'; ctx.fillRect(sx+W*0.30,eyY-4,W*0.16,3); ctx.fillRect(sx+W*0.54,eyY-4,W*0.16,3); ctx.fillStyle='#3a1510'; ctx.fillRect(sx+W*0.38,sy+H*0.82,W*0.24,3); ctx.fillStyle='#fff'; ctx.fillRect(sx+W*0.42,sy+H*0.82,3,3); ctx.fillRect(sx+W*0.54,sy+H*0.82,3,3); }
  ctx.fillStyle='#e8d2a8'; ctx.fillRect(sx+W*0.3,sy+H-3,W*0.14,3+stepY); ctx.fillRect(sx+W*0.56,sy+H-3,W*0.14,3-stepY);
}
// VOLPE inseguitrice
function drawFox(fx){
  const sx=fx.x-game.cam, sy=fx.y; if(sx<-60||sx>VIEW_W+60) return;
  ctx.save(); ctx.translate(sx+fx.w/2, sy); ctx.scale(fx.facing,1); ctx.translate(-fx.w/2,0);
  const run = Math.sin(performance.now()*0.02)*2;
  const RED='#d9651f', RED_D='#b14e12', WHITE='#f7e9d2', DARK='#2a1708';
  // coda
  ctx.fillStyle=RED; ctx.beginPath(); ctx.moveTo(2,16); ctx.quadraticCurveTo(-18,10,-14,24); ctx.quadraticCurveTo(-6,22,6,22); ctx.fill();
  ctx.fillStyle=WHITE; ctx.beginPath(); ctx.arc(-13,20,4,0,6.28); ctx.fill();
  // zampe
  ctx.fillStyle=RED_D; ctx.fillRect(10,24,5,6+run); ctx.fillRect(26,24,5,6-run); ctx.fillRect(16,24,5,6-run); ctx.fillRect(32,24,5,6+run);
  // corpo
  ctx.fillStyle=RED; ctx.fillRect(8,12,30,14); ctx.fillStyle=WHITE; ctx.fillRect(8,20,30,6);
  // testa
  ctx.fillStyle=RED; ctx.fillRect(32,6,14,14);
  ctx.beginPath(); ctx.moveTo(32,6); ctx.lineTo(36,-2); ctx.lineTo(40,6); ctx.closePath(); ctx.fill();   // orecchio
  ctx.beginPath(); ctx.moveTo(40,6); ctx.lineTo(44,-2); ctx.lineTo(46,6); ctx.closePath(); ctx.fill();
  ctx.fillStyle=WHITE; ctx.fillRect(40,13,8,7);     // musetto chiaro
  ctx.fillStyle=DARK; ctx.fillRect(46,15,3,3);      // naso
  ctx.fillStyle=DARK; ctx.fillRect(37,10,3,3);      // occhio
  ctx.restore();
}
// scala di legno per accedere/risalire dalle grotte
function drawLadder(L){
  const sx=L.x-game.cam; if(sx<-40||sx>VIEW_W+40) return;
  const h=L.yBot-L.yTop;
  ctx.fillStyle='#8a5a2b';
  ctx.fillRect(sx, L.yTop, 4, h);
  ctx.fillRect(sx+L.w-4, L.yTop, 4, h);
  ctx.fillStyle='#a06a33';
  for (let y=L.yTop+6; y<L.yBot; y+=12) ctx.fillRect(sx, y, L.w, 4);
}

function drawBush(b, front){
  const sx=b.x-game.cam; if(sx<-100||sx>VIEW_W+100) return;
  // 'back' = corpo cespuglio; 'front' = fronda semitrasparente che copre Eddy
  if (!front){
    ctx.fillStyle='#2e7d32';
    for (let x=0;x<b.w;x+=16){ ctx.beginPath(); ctx.arc(sx+x+8,b.y+b.h-8,12,0,6.28); ctx.fill(); }
    ctx.fillStyle='#3a9d3f';
    for (let x=0;x<b.w;x+=14){ ctx.beginPath(); ctx.arc(sx+x+6,b.y+b.h-14,9,0,6.28); ctx.fill(); }
  } else {
    ctx.save(); ctx.globalAlpha=0.82; ctx.fillStyle='#45b24a';
    for (let x=0;x<b.w;x+=12){ ctx.beginPath(); ctx.arc(sx+x+6,b.y+b.h-18,8,0,6.28); ctx.fill(); }
    ctx.globalAlpha=1; ctx.restore();
  }
}
function drawParticles(){
  for (const p of particles){ const sx=p.x-game.cam; if(sx<-10||sx>VIEW_W+10) continue; ctx.globalAlpha=clamp(p.life/650,0,1); ctx.fillStyle=p.color; ctx.fillRect(sx,p.y,p.size,p.size); }
  ctx.globalAlpha=1;
}
function drawGull(sx,sy,flap){
  if(sx<-40||sx>VIEW_W+40) return;
  const wing=Math.sin(flap)*6; ctx.strokeStyle='#f4f8ff'; ctx.lineWidth=3;
  ctx.beginPath(); ctx.moveTo(sx-10,sy+wing); ctx.quadraticCurveTo(sx-3,sy-4,sx,sy); ctx.quadraticCurveTo(sx+3,sy-4,sx+10,sy+wing); ctx.stroke();
  ctx.fillStyle='#eef4ff'; ctx.fillRect(sx-1,sy-1,3,3); ctx.fillStyle='#ffb02e'; ctx.fillRect(sx+1,sy,2,1); ctx.lineWidth=1;
}
function drawGoal(){
  const sx=currentLevel.goalX-game.cam; if(sx<-60||sx>VIEW_W+60) return;
  const gy=currentLevel.ground(currentLevel.goalX);
  ctx.fillStyle='#eee'; ctx.fillRect(sx,gy-100,5,100);
  ctx.fillStyle='#ffd43b'; const wave=Math.sin(performance.now()*0.006)*4;
  ctx.beginPath(); ctx.moveTo(sx+5,gy-100); ctx.lineTo(sx+44+wave,gy-88); ctx.lineTo(sx+5,gy-74); ctx.closePath(); ctx.fill();
  ctx.fillStyle='#e74c3c'; ctx.fillRect(sx+14,gy-94,10,10); ctx.fillStyle='#c0392b'; ctx.fillRect(sx-2,gy-4,9,4);
}
function drawPopups(){
  ctx.save(); ctx.textAlign='center'; ctx.font='bold 18px "Trebuchet MS", sans-serif';
  for (const pu of popups){ const sx=pu.x-game.cam, sy=pu.y; if(sx<-40||sx>VIEW_W+40) continue;
    ctx.globalAlpha=Math.max(0,pu.life/pu.maxLife); ctx.lineWidth=3; ctx.strokeStyle='rgba(0,0,0,.6)'; ctx.strokeText(pu.text,sx,sy); ctx.fillStyle=pu.color; ctx.fillText(pu.text,sx,sy); }
  ctx.restore();
}

// -------------------------- EDDY pixel-art ----------------------------------
function drawEddy(){
  const sx=Math.round(eddy.x-game.cam), sy=Math.round(eddy.y);
  // lampeggio quando potenziato
  if (eddy.power>0 && Math.floor(performance.now()/90)%2===0){ /* skip frame per effetto flash */ }
  ctx.save(); ctx.translate(sx+eddy.w/2,sy); ctx.scale(eddy.facing,1); ctx.translate(-eddy.w/2,0);
  const ORANGE='#f28b2b', ORANGE_D='#d9701a', CREAM='#ffe3b3', DARK='#3a2412', GREEN='#3a9d3f', YELLOW='#ffd43b';
  const airborne=!eddy.onGround && !eddy.climbing;
  const legPhase=(eddy.onGround && Math.abs(eddy.vx)>0.4)?eddy.runFrame:0;

  // aura potenziamento
  if (eddy.power>0){ ctx.save(); ctx.globalAlpha=0.35+0.2*Math.abs(Math.sin(performance.now()*0.01)); ctx.fillStyle='#ffe14d'; ctx.beginPath(); ctx.arc(15,20,26,0,6.28); ctx.fill(); ctx.restore(); }

  // CODA attaccata
  ctx.fillStyle=ORANGE; ctx.beginPath(); ctx.moveTo(6,34); ctx.quadraticCurveTo(-10,34,-14,20); ctx.quadraticCurveTo(-16,6,-4,2); ctx.quadraticCurveTo(-2,14,4,24); ctx.quadraticCurveTo(6,30,6,34); ctx.closePath(); ctx.fill();
  ctx.fillStyle=ORANGE_D; for(let i=0;i<3;i++) ctx.fillRect(-12+i*2,12+i*7,10-i*2,3);
  ctx.fillStyle=CREAM; ctx.beginPath(); ctx.arc(-9,5,4,0,6.28); ctx.fill();

  // GAMBE
  ctx.fillStyle=ORANGE;
  if (airborne){ ctx.fillRect(7,32,7,9); ctx.fillRect(17,32,7,7); }
  else if (legPhase){ ctx.fillRect(5,32,7,10); ctx.fillRect(18,32,7,8); }
  else { ctx.fillRect(7,32,7,8); ctx.fillRect(17,32,7,10); }
  ctx.fillStyle=DARK; ctx.fillRect(5,40,10,3); ctx.fillRect(16,40,10,3);

  // CORPO maglia
  for (let i=0;i<5;i++){ ctx.fillStyle=(i%2===0)?GREEN:YELLOW; ctx.fillRect(7,18+i*3,18,3); }
  ctx.fillStyle=ORANGE_D; ctx.fillRect(7,18,18,1);

  // BRACCIA
  ctx.fillStyle=ORANGE;
  if (eddy.climbing){
    if (eddy.climbFrame){ ctx.fillRect(2,8,6,12); ctx.fillRect(23,20,6,10); } else { ctx.fillRect(2,20,6,10); ctx.fillRect(23,8,6,12); }
    ctx.fillStyle=CREAM; if (eddy.climbFrame){ ctx.fillRect(2,6,6,4); ctx.fillRect(23,28,6,4); } else { ctx.fillRect(2,28,6,4); ctx.fillRect(23,6,6,4); }
  } else if (airborne){ ctx.fillRect(2,14,6,10); ctx.fillRect(24,14,6,10); ctx.fillStyle=CREAM; ctx.fillRect(2,22,6,4); ctx.fillRect(24,22,6,4); }
  else { ctx.fillRect(3,20,6,10); ctx.fillRect(23,20,6,10); ctx.fillStyle=CREAM; ctx.fillRect(3,28,6,4); ctx.fillRect(23,28,6,4); }

  // TESTA
  ctx.fillStyle=ORANGE; ctx.fillRect(5,0,22,18);
  ctx.fillRect(6,-4,6,6); ctx.fillRect(20,-4,6,6);
  ctx.fillStyle=ORANGE_D; ctx.fillRect(8,-2,2,3); ctx.fillRect(22,-2,2,3);
  ctx.fillStyle=CREAM; ctx.fillRect(12,6,15,12);
  ctx.fillStyle=DARK; ctx.fillRect(24,9,4,3);
  ctx.fillStyle='#fff'; ctx.fillRect(16,4,6,6); ctx.fillStyle=DARK; ctx.fillRect(19,5,3,4);
  ctx.fillStyle='#fff'; ctx.fillRect(20,14,3,4); ctx.fillRect(23,14,3,4); ctx.fillStyle='#ddd'; ctx.fillRect(23,14,1,4);
  if (eddy.dead){ ctx.fillStyle=DARK; ctx.fillRect(16,5,6,2); }
  ctx.restore();
}

// ============================= LOOP =========================================
let last = performance.now();
function loop(){
  const now=performance.now(); let dt=now-last; last=now; if(dt>50) dt=50;
  if (game.state==='play' && !game.over) update(dt);
  draw();
  game.raf = requestAnimationFrame(loop);
}

// avvio: mostra il menu
showMenu();
