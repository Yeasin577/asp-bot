javascript:(function(){
try{if(window.__ASP_BOT__&&typeof window.__ASP_BOT__.destroy==="function")window.__ASP_BOT__.destroy();}catch(e){}

var ROOT_ID='asp-bot-root';
var STORAGE_KEY='aspBotSettings_v1';
var defaults={delaySec:5,direction:'auto',rsiPeriod:14,emaPeriod:9,minConfidence:65};

/* ── Settings ── */
function loadSettings(){
  try{var s=JSON.parse(localStorage.getItem(STORAGE_KEY));if(s)return s;}catch(e){}
  return Object.assign({},defaults);
}
function saveSettings(s){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(s));}catch(e){}}
var settings=loadSettings();

/* ── Price Buffer ── */
var priceBuffer=[];
var MAX_BUFFER=100;
var lastSignal=null;
var wsIntercepted=false;

/* ── WebSocket Intercept ── */
function interceptWebSocket(){
  if(wsIntercepted)return;
  wsIntercepted=true;
  var OrigWS=window.WebSocket;
  window.WebSocket=function(url,proto){
    var ws=proto?new OrigWS(url,proto):new OrigWS(url);
    ws.addEventListener('message',function(e){
      try{
        var raw=typeof e.data==='string'?e.data:null;
        if(!raw)return;
        var d=JSON.parse(raw);
        // Quotex WS format
        var price=null;
        if(d&&d.asset&&d.price)price=parseFloat(d.price);
        else if(d&&d[1]&&d[1].price)price=parseFloat(d[1].price);
        else if(d&&typeof d.p==='number')price=d.p;
        else if(Array.isArray(d)&&d[1]&&d[1][1])price=parseFloat(d[1][1]);
        if(price&&!isNaN(price)){
          priceBuffer.push(price);
          if(priceBuffer.length>MAX_BUFFER)priceBuffer.shift();
          onNewPrice(price);
        }
      }catch(err){}
    });
    return ws;
  };
  window.WebSocket.prototype=OrigWS.prototype;
  console.log('[ASP Bot] WebSocket intercepted');
}

/* ── DOM Price Fallback ── */
function getPriceFromDOM(){
  var selectors=[
    '.chart-price__value',
    '.price-value',
    '[class*="currentPrice"]',
    '[class*="current-price"]',
    '.js-price',
    '[data-price]'
  ];
  for(var i=0;i<selectors.length;i++){
    var el=document.querySelector(selectors[i]);
    if(el){
      var txt=(el.textContent||el.getAttribute('data-price')||'').replace(/[^0-9.]/g,'');
      var p=parseFloat(txt);
      if(!isNaN(p)&&p>0)return p;
    }
  }
  return null;
}

var domPriceTimer=null;
function startDOMPriceFallback(){
  if(domPriceTimer)return;
  domPriceTimer=setInterval(function(){
    if(priceBuffer.length<10){
      var p=getPriceFromDOM();
      if(p){
        priceBuffer.push(p);
        if(priceBuffer.length>MAX_BUFFER)priceBuffer.shift();
      }
    }
  },1000);
}

/* ── Technical Indicators ── */
function calcEMA(prices,period){
  if(prices.length<period)return null;
  var k=2/(period+1);
  var ema=prices.slice(0,period).reduce(function(a,b){return a+b;},0)/period;
  for(var i=period;i<prices.length;i++){
    ema=prices[i]*k+ema*(1-k);
  }
  return ema;
}

function calcRSI(prices,period){
  if(!period)period=settings.rsiPeriod||14;
  if(prices.length<period+1)return null;
  var gains=0,losses=0;
  for(var i=prices.length-period;i<prices.length;i++){
    var diff=prices[i]-prices[i-1];
    if(diff>0)gains+=diff;
    else losses+=Math.abs(diff);
  }
  if(losses===0)return 100;
  var rs=gains/losses;
  return 100-(100/(1+rs));
}

function calcMACD(prices){
  var ema12=calcEMA(prices,12);
  var ema26=calcEMA(prices,26);
  if(ema12===null||ema26===null)return null;
  return ema12-ema26;
}

function calcBollingerBands(prices,period){
  if(!period)period=20;
  if(prices.length<period)return null;
  var slice=prices.slice(-period);
  var mean=slice.reduce(function(a,b){return a+b;},0)/period;
  var variance=slice.reduce(function(a,b){return a+Math.pow(b-mean,2);},0)/period;
  var std=Math.sqrt(variance);
  return{upper:mean+2*std,middle:mean,lower:mean-2*std};
}

function calcStochastic(prices,period){
  if(!period)period=14;
  if(prices.length<period)return null;
  var slice=prices.slice(-period);
  var high=Math.max.apply(null,slice);
  var low=Math.min.apply(null,slice);
  var current=prices[prices.length-1];
  if(high===low)return 50;
  return((current-low)/(high-low))*100;
}

function detectCandlePattern(prices){
  if(prices.length<4)return null;
  var len=prices.length;
  var c1=prices[len-4],c2=prices[len-3],c3=prices[len-2],c4=prices[len-1];
  // Higher highs + higher lows = uptrend
  if(c4>c3&&c3>c2&&c2>c1)return{pattern:'uptrend',bias:'UP',strength:80};
  if(c4<c3&&c3<c2&&c2<c1)return{pattern:'downtrend',bias:'DOWN',strength:80};
  // Bounce patterns
  if(c3<c2&&c3<c1&&c4>c3)return{pattern:'reversal_up',bias:'UP',strength:70};
  if(c3>c2&&c3>c1&&c4<c3)return{pattern:'reversal_down',bias:'DOWN',strength:70};
  return null;
}

/* ── Signal Engine ── */
function analyzeSignal(){
  var prices=priceBuffer.slice();
  if(prices.length<30){
    return{signal:null,confidence:0,reason:'Not enough data ('+prices.length+'/30)'};
  }

  var scores={UP:0,DOWN:0};
  var reasons=[];

  // RSI
  var rsi=calcRSI(prices);
  if(rsi!==null){
    if(rsi<30){scores.UP+=25;reasons.push('RSI oversold('+rsi.toFixed(1)+')');}
    else if(rsi>70){scores.DOWN+=25;reasons.push('RSI overbought('+rsi.toFixed(1)+')');}
    else if(rsi<45){scores.UP+=10;reasons.push('RSI bearish zone');}
    else if(rsi>55){scores.DOWN+=10;reasons.push('RSI bullish zone');}
  }

  // EMA cross
  var ema9=calcEMA(prices,9);
  var ema21=calcEMA(prices,21);
  if(ema9!==null&&ema21!==null){
    var current=prices[prices.length-1];
    if(ema9>ema21&&current>ema9){scores.UP+=20;reasons.push('EMA9>EMA21 bullish');}
    else if(ema9<ema21&&current<ema9){scores.DOWN+=20;reasons.push('EMA9<EMA21 bearish');}
  }

  // MACD
  var macd=calcMACD(prices);
  if(macd!==null){
    if(macd>0){scores.UP+=15;reasons.push('MACD positive');}
    else{scores.DOWN+=15;reasons.push('MACD negative');}
  }

  // Bollinger Bands
  var bb=calcBollingerBands(prices,20);
  if(bb!==null){
    var cur=prices[prices.length-1];
    if(cur<=bb.lower){scores.UP+=20;reasons.push('Price at BB lower');}
    else if(cur>=bb.upper){scores.DOWN+=20;reasons.push('Price at BB upper');}
  }

  // Stochastic
  var stoch=calcStochastic(prices,14);
  if(stoch!==null){
    if(stoch<20){scores.UP+=15;reasons.push('Stoch oversold('+stoch.toFixed(1)+')');}
    else if(stoch>80){scores.DOWN+=15;reasons.push('Stoch overbought('+stoch.toFixed(1)+')');}
  }

  // Candle pattern
  var pattern=detectCandlePattern(prices);
  if(pattern){
    scores[pattern.bias]+=pattern.strength/4;
    reasons.push(pattern.pattern);
  }

  var total=scores.UP+scores.DOWN;
  if(total===0)return{signal:null,confidence:0,reason:'No signal'};

  var winner=scores.UP>=scores.DOWN?'UP':'DOWN';
  var confidence=Math.round((Math.max(scores.UP,scores.DOWN)/total)*100);

  return{
    signal:winner,
    confidence:confidence,
    upScore:scores.UP,
    downScore:scores.DOWN,
    reason:reasons.join(' | '),
    rsi:rsi,
    macd:macd,
    stoch:stoch
  };
}

/* ── UI ── */
var style=document.createElement('style');
style.textContent=[
  '#'+ROOT_ID+'{all:initial;font-family:Consolas,Monaco,monospace;}',
  '#'+ROOT_ID+' *{box-sizing:border-box;font-family:inherit;}',
  '#'+ROOT_ID+' .fab{position:fixed;z-index:2147483000;right:18px;bottom:90px;width:76px;display:flex;flex-direction:column;align-items:center;user-select:none;cursor:grab;touch-action:none;}',
  '#'+ROOT_ID+' .fab:active{cursor:grabbing;}',
  '#'+ROOT_ID+' .fab.glow{filter:drop-shadow(0 0 14px #00ff66) drop-shadow(0 0 30px rgba(0,255,102,.6));}',
  '#'+ROOT_ID+' .pulse{position:absolute;inset:-4px;border-radius:50%;border:1px solid rgba(255,79,192,.5);animation:pulse 2s ease-out infinite;pointer-events:none;}',
  '@keyframes pulse{0%{transform:scale(.9);opacity:.9;}100%{transform:scale(1.5);opacity:0;}}',
  '#'+ROOT_ID+' .icon{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#0a1a0f,#051208);border:2px solid #00ff88;box-shadow:0 0 14px rgba(0,255,136,.5);display:flex;align-items:center;justify-content:center;font-size:26px;position:relative;}',
  '#'+ROOT_ID+' .lbl{margin-top:5px;font-size:9px;font-weight:700;color:#00ff88;letter-spacing:.3px;text-align:center;white-space:nowrap;}',
  '#'+ROOT_ID+' .conf-badge{position:absolute;top:-6px;right:-6px;background:#00ff88;color:#000;font-size:9px;font-weight:900;padding:2px 5px;border-radius:8px;min-width:28px;text-align:center;}',
  '#'+ROOT_ID+' .conf-badge.low{background:#ff6b6b;}',
  '#'+ROOT_ID+' .conf-badge.mid{background:#ffa500;}',
  '#'+ROOT_ID+' .panel{position:fixed;z-index:2147483001;width:min(320px,calc(100vw - 24px));left:50%;top:50%;transform:translate(-50%,-50%);background:linear-gradient(160deg,#030d06,#071510,#050d12);border:1px solid #00ff88;border-radius:12px;box-shadow:0 0 30px rgba(0,255,136,.2),0 16px 48px rgba(0,0,0,.6);color:#b8ffd0;display:none;}',
  '#'+ROOT_ID+' .panel.open{display:block;}',
  '#'+ROOT_ID+' .bd{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:none;}',
  '#'+ROOT_ID+' .bd.open{display:block;}',
  '#'+ROOT_ID+' .ph{padding:10px 14px;background:rgba(0,255,136,.07);border-bottom:1px solid rgba(0,255,136,.2);display:flex;align-items:center;justify-content:space-between;}',
  '#'+ROOT_ID+' .pt{font-size:13px;font-weight:700;color:#00ff88;}',
  '#'+ROOT_ID+' .pc{background:transparent;border:1px solid #00ff88;color:#00ff88;width:26px;height:26px;border-radius:4px;cursor:pointer;font-size:15px;}',
  '#'+ROOT_ID+' .pb{padding:14px;}',
  '#'+ROOT_ID+' .fld{margin-bottom:12px;}',
  '#'+ROOT_ID+' .fld label{display:block;font-size:10px;color:#7dffb0;text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px;}',
  '#'+ROOT_ID+' .inp{width:100%;background:#040f08;border:1px solid #1a5c36;color:#e8ffe8;padding:8px 10px;border-radius:5px;font-size:13px;outline:none;}',
  '#'+ROOT_ID+' .inp:focus{border-color:#00ff88;}',
  '#'+ROOT_ID+' .dirs{display:flex;gap:8px;}',
  '#'+ROOT_ID+' .dir{flex:1;padding:10px 6px;border-radius:8px;border:1px solid rgba(0,255,102,.2);background:rgba(0,0,0,.3);color:#dfffe8;font-size:12px;font-weight:600;cursor:pointer;text-align:center;}',
  '#'+ROOT_ID+' .dir.active{background:rgba(0,255,102,.18);border-color:#00ff66;color:#00ff66;}',
  '#'+ROOT_ID+' .savebtn{width:100%;padding:12px;border-radius:5px;border:0;background:#00ff88;color:#030d06;font-weight:800;cursor:pointer;font-size:13px;margin-top:4px;}',
  '#'+ROOT_ID+' .signal-box{background:rgba(0,255,136,.05);border:1px solid rgba(0,255,136,.2);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:11px;line-height:1.6;}',
  '#'+ROOT_ID+' .sig-up{color:#00ff88;font-weight:700;}',
  '#'+ROOT_ID+' .sig-dn{color:#ff4444;font-weight:700;}',
  '#'+ROOT_ID+' .hint{font-size:10px;color:#5a8a68;text-align:center;margin-top:10px;}',
  '#'+ROOT_ID+' .scan{position:fixed;inset:0;z-index:2147483640;pointer-events:none;overflow:hidden;display:none;}',
  '#'+ROOT_ID+' .scan.on{display:block;}',
  '#'+ROOT_ID+' .scan-line{position:absolute;left:0;width:100%;height:4px;background:linear-gradient(180deg,#3ad67f,#00a050);box-shadow:0 -60px 100px rgba(0,220,115,1),0 -30px 60px rgba(0,200,100,.9),0 0 30px rgba(0,150,75,.8);top:-5%;animation:scanMove 1.4s linear infinite;}',
  '@keyframes scanMove{0%{top:-5%;}100%{top:105%;}}'
].join('\n');
document.documentElement.appendChild(style);

var root=document.createElement('div');
root.id=ROOT_ID;
document.documentElement.appendChild(root);

var scanEl=document.createElement('div');
scanEl.className='scan';
scanEl.innerHTML='<div class="scan-line"></div>';
root.appendChild(scanEl);

var bd=document.createElement('div');
bd.className='bd';
root.appendChild(bd);

var fab=document.createElement('div');
fab.className='fab';
fab.innerHTML='<div class="pulse"></div><div class="icon"><span>🤖</span><div class="conf-badge" id="asp-conf">--</div></div><div class="lbl">ASP Smart Bot</div>';
root.appendChild(fab);

var panel=document.createElement('div');
panel.className='panel';
panel.innerHTML=[
  '<div class="ph"><div class="pt">⚡ ASP SMART BOT</div><button class="pc">\xd7</button></div>',
  '<div class="pb">',
  '<div class="signal-box" id="asp-sigbox">',
  '<div>Signal: <span id="asp-sig">Analyzing...</span></div>',
  '<div>Confidence: <span id="asp-conf2">--</span></div>',
  '<div>RSI: <span id="asp-rsi">--</span></div>',
  '<div>MACD: <span id="asp-macd">--</span></div>',
  '<div>Stoch: <span id="asp-stoch">--</span></div>',
  '<div style="font-size:10px;color:#5a8a68;margin-top:4px;" id="asp-reason">Waiting for price data...</div>',
  '</div>',
  '<div class="fld"><label>Delay before trade (sec)</label><input class="inp" id="asp-delay" type="number" min="1" max="120" value="5"/></div>',
  '<div class="fld"><label>Min confidence to trade (%)</label><input class="inp" id="asp-mconf" type="number" min="50" max="95" value="65"/></div>',
  '<div class="fld"><label>Direction mode</label>',
  '<div class="dirs" id="asp-dirs">',
  '<div class="dir active" data-dir="auto">Auto AI</div>',
  '<div class="dir" data-dir="up">Force UP</div>',
  '<div class="dir" data-dir="down">Force DOWN</div>',
  '</div></div>',
  '<div style="font-size:10px;color:#5a8a68;margin-bottom:10px;">Auto AI = RSI+EMA+MACD+BB+Stoch combined signal</div>',
  '<button class="savebtn" id="asp-save">SAVE &amp; CLOSE</button>',
  '<div class="hint">1 tap: start/stop · 3 taps: settings</div>',
  '</div>'
].join('');
root.appendChild(panel);

var confBadge=root.querySelector('#asp-conf');
var sigEl=root.querySelector('#asp-sig');
var conf2El=root.querySelector('#asp-conf2');
var rsiEl=root.querySelector('#asp-rsi');
var macdEl=root.querySelector('#asp-macd');
var stochEl=root.querySelector('#asp-stoch');
var reasonEl=root.querySelector('#asp-reason');
var delayInp=root.querySelector('#asp-delay');
var mconfInp=root.querySelector('#asp-mconf');
var dirBtns=root.querySelectorAll('#asp-dirs .dir');
var pendingDir=settings.direction||'auto';

function syncDirs(){Array.prototype.forEach.call(dirBtns,function(b){b.classList.toggle('active',b.getAttribute('data-dir')===pendingDir);});}
syncDirs();

Array.prototype.forEach.call(dirBtns,function(b){
  b.addEventListener('click',function(){pendingDir=b.getAttribute('data-dir');syncDirs();});
});

function openPanel(){
  delayInp.value=settings.delaySec||5;
  mconfInp.value=settings.minConfidence||65;
  pendingDir=settings.direction||'auto';
  syncDirs();
  bd.classList.add('open');
  panel.classList.add('open');
}
function closePanel(){bd.classList.remove('open');panel.classList.remove('open');}
bd.addEventListener('click',closePanel);
panel.querySelector('.pc').addEventListener('click',closePanel);
root.querySelector('#asp-save').addEventListener('click',function(){
  settings.delaySec=Math.max(1,Math.min(120,parseInt(delayInp.value)||5));
  settings.minConfidence=Math.max(50,Math.min(95,parseInt(mconfInp.value)||65));
  settings.direction=pendingDir;
  saveSettings(settings);
  closePanel();
});

/* ── Signal Display Update ── */
function updateSignalDisplay(analysis){
  if(!analysis)return;
  var s=analysis.signal;
  if(s==='UP'){sigEl.textContent='▲ UP';sigEl.className='sig-up';}
  else if(s==='DOWN'){sigEl.textContent='▼ DOWN';sigEl.className='sig-dn';}
  else{sigEl.textContent='WAIT';sigEl.className='';}
  var c=analysis.confidence||0;
  conf2El.textContent=c+'%';
  if(rsiEl&&analysis.rsi!==null&&analysis.rsi!==undefined)rsiEl.textContent=analysis.rsi.toFixed(1);
  if(macdEl&&analysis.macd!==null&&analysis.macd!==undefined)macdEl.textContent=analysis.macd.toFixed(5);
  if(stochEl&&analysis.stoch!==null&&analysis.stoch!==undefined)stochEl.textContent=analysis.stoch.toFixed(1);
  if(reasonEl)reasonEl.textContent=analysis.reason||'';
  // Badge
  confBadge.textContent=c+'%';
  confBadge.className='conf-badge';
  if(c<60)confBadge.classList.add('low');
  else if(c<75)confBadge.classList.add('mid');
}

var signalUpdateTimer=null;
function startSignalUpdate(){
  if(signalUpdateTimer)return;
  signalUpdateTimer=setInterval(function(){
    var a=analyzeSignal();
    updateSignalDisplay(a);
    lastSignal=a;
  },2000);
}

/* ── Trade Logic ── */
function getTradeButtons(){
  var wrap=document.querySelector('#trade-button');
  if(!wrap)return{up:null,down:null};
  var btns=Array.prototype.slice.call(wrap.querySelectorAll('button'));
  var up=btns.find(function(b){return/up/i.test(b.textContent||'')||b.classList.contains('JQZcs');})||wrap.querySelector('button.JQZcs');
  var dn=btns.find(function(b){return/down/i.test(b.textContent||'')||b.classList.contains('twQq3');})||wrap.querySelector('button.twQq3');
  return{up:up,down:dn};
}

function placeTrade(){
  var analysis=analyzeSignal();
  lastSignal=analysis;
  updateSignalDisplay(analysis);

  var dir=settings.direction||'auto';
  var btn=null;
  var btns=getTradeButtons();

  if(dir==='up'){btn=btns.up;}
  else if(dir==='down'){btn=btns.down;}
  else{
    // AUTO mode — use signal
    var minConf=settings.minConfidence||65;
    if(!analysis.signal||analysis.confidence<minConf){
      console.log('[ASP Bot] Signal too weak ('+analysis.confidence+'% < '+minConf+'%) — skipping trade');
      scheduleNext();
      return;
    }
    btn=analysis.signal==='UP'?btns.up:btns.down;
    console.log('[ASP Bot] AI Signal:',analysis.signal,'| Confidence:',analysis.confidence+'%','| Reason:',analysis.reason);
  }

  if(btn){
    btn.click();
    console.log('[ASP Bot] Trade placed!');
  } else {
    console.error('[ASP Bot] Trade button not found');
  }
  scheduleNext();
}

var state={running:false,timer:null};

function scheduleNext(){
  if(!state.running)return;
  state.timer=setTimeout(placeTrade,settings.delaySec*1000);
}

function startBot(){
  if(state.running)return;
  state.running=true;
  fab.classList.add('glow');
  scanEl.classList.add('on');
  startSignalUpdate();
  state.timer=setTimeout(placeTrade,settings.delaySec*1000);
  console.log('[ASP Bot] Started');
}

function stopBot(){
  state.running=false;
  if(state.timer){clearTimeout(state.timer);state.timer=null;}
  fab.classList.remove('glow');
  scanEl.classList.remove('on');
  console.log('[ASP Bot] Stopped');
}

/* ── Tap Logic ── */
var tapCount=0,lastTap=0,tapTimer=null;
function registerTap(){
  if(panel.classList.contains('open'))return;
  var now=Date.now();
  if(now-lastTap>650)tapCount=0;
  lastTap=now;tapCount++;
  if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}
  if(tapCount>=3){tapCount=0;openPanel();return;}
  tapTimer=setTimeout(function(){
    tapTimer=null;
    if(tapCount===1){if(state.running)stopBot();else startBot();}
    tapCount=0;
  },380);
}

/* ── Drag ── */
var drag={on:false,moved:false,sx:0,sy:0,sl:0,st:0};
function onDown(cx,cy){
  drag.on=true;drag.moved=false;
  var r=fab.getBoundingClientRect();
  drag.sx=cx;drag.sy=cy;drag.sl=r.left;drag.st=r.top;
  fab.style.right='auto';fab.style.bottom='auto';
  fab.style.left=drag.sl+'px';fab.style.top=drag.st+'px';
}
function onMove(cx,cy){
  if(!drag.on)return;
  var dx=cx-drag.sx,dy=cy-drag.sy;
  if(Math.abs(dx)>8||Math.abs(dy)>8)drag.moved=true;
  var r=fab.getBoundingClientRect();
  fab.style.left=Math.max(0,Math.min(drag.sl+dx,window.innerWidth-r.width))+'px';
  fab.style.top=Math.max(0,Math.min(drag.st+dy,window.innerHeight-r.height))+'px';
}
function onUp(){if(!drag.on)return;drag.on=false;if(!drag.moved)registerTap();}
fab.addEventListener('mousedown',function(e){e.preventDefault();onDown(e.clientX,e.clientY);});
fab.addEventListener('touchstart',function(e){if(e.touches.length!==1)return;e.preventDefault();var t=e.touches[0];onDown(t.clientX,t.clientY);},{passive:false});
document.addEventListener('mousemove',function(e){onMove(e.clientX,e.clientY);});
document.addEventListener('touchmove',function(e){if(!drag.on||e.touches.length!==1)return;e.preventDefault();onMove(e.touches[0].clientX,e.touches[0].clientY);},{passive:false});
document.addEventListener('mouseup',onUp);
document.addEventListener('touchend',onUp);
document.addEventListener('touchcancel',onUp);

/* ── Price feed hook on page load ── */
function onNewPrice(p){
  // signal auto-updates via interval
}

interceptWebSocket();
startDOMPriceFallback();
startSignalUpdate();

function destroy(){
  stopBot();
  if(signalUpdateTimer){clearInterval(signalUpdateTimer);signalUpdateTimer=null;}
  if(domPriceTimer){clearInterval(domPriceTimer);domPriceTimer=null;}
  closePanel();
  if(style.parentNode)style.parentNode.removeChild(style);
  if(root.parentNode)root.parentNode.removeChild(root);
  delete window.__ASP_BOT__;
}

window.__ASP_BOT__={destroy:destroy,start:startBot,stop:stopBot,state:state,analyze:analyzeSignal};
console.log('%c[ASP Smart Bot] Loaded — WebSocket+RSI+EMA+MACD+BB+Stoch active','color:#00ff88;font-weight:bold');
})();
