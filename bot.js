(function(){
try{if(window.__ASP_BOT__&&typeof window.__ASP_BOT__.destroy==="function")window.__ASP_BOT__.destroy();}catch(e){}

var ROOT_ID='asp-bot-root';
var STORAGE_KEY='aspBotSettings_v1';
var defaults={delaySec:5,direction:'auto',rsiPeriod:14,minConfidence:65};

function loadSettings(){try{var s=JSON.parse(localStorage.getItem(STORAGE_KEY));if(s)return s;}catch(e){}return Object.assign({},defaults);}
function saveSettings(s){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(s));}catch(e){}}
var settings=loadSettings();

var priceBuffer=[];
var MAX_BUFFER=100;
var lastSignal=null;
var wsIntercepted=false;

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
        var price=null;
        if(d&&d.asset&&d.price)price=parseFloat(d.price);
        else if(d&&d[1]&&d[1].price)price=parseFloat(d[1].price);
        else if(d&&typeof d.p==='number')price=d.p;
        else if(Array.isArray(d)&&d[1]&&d[1][1])price=parseFloat(d[1][1]);
        if(price&&!isNaN(price)){
          priceBuffer.push(price);
          if(priceBuffer.length>MAX_BUFFER)priceBuffer.shift();
        }
      }catch(err){}
    });
    return ws;
  };
  window.WebSocket.prototype=OrigWS.prototype;
}

var domPriceTimer=null;
function startDOMPriceFallback(){
  if(domPriceTimer)return;
  domPriceTimer=setInterval(function(){
    if(priceBuffer.length<10){
      var selectors=['.chart-price__value','.price-value','[class*="currentPrice"]','[class*="current-price"]','.js-price','[data-price]'];
      for(var i=0;i<selectors.length;i++){
        var el=document.querySelector(selectors[i]);
        if(el){
          var p=parseFloat((el.textContent||el.getAttribute('data-price')||'').replace(/[^0-9.]/g,''));
          if(!isNaN(p)&&p>0){priceBuffer.push(p);if(priceBuffer.length>MAX_BUFFER)priceBuffer.shift();break;}
        }
      }
    }
  },1000);
}

function calcEMA(prices,period){
  if(prices.length<period)return null;
  var k=2/(period+1);
  var ema=prices.slice(0,period).reduce(function(a,b){return a+b;},0)/period;
  for(var i=period;i<prices.length;i++){ema=prices[i]*k+ema*(1-k);}
  return ema;
}

function calcRSI(prices,period){
  if(!period)period=14;
  if(prices.length<period+1)return null;
  var gains=0,losses=0;
  for(var i=prices.length-period;i<prices.length;i++){
    var diff=prices[i]-prices[i-1];
    if(diff>0)gains+=diff;else losses+=Math.abs(diff);
  }
  if(losses===0)return 100;
  return 100-(100/(1+(gains/losses)));
}

function calcMACD(prices){
  var e12=calcEMA(prices,12),e26=calcEMA(prices,26);
  if(e12===null||e26===null)return null;
  return e12-e26;
}

function calcBB(prices,period){
  if(!period)period=20;
  if(prices.length<period)return null;
  var sl=prices.slice(-period);
  var mean=sl.reduce(function(a,b){return a+b;},0)/period;
  var std=Math.sqrt(sl.reduce(function(a,b){return a+Math.pow(b-mean,2);},0)/period);
  return{upper:mean+2*std,middle:mean,lower:mean-2*std};
}

function calcStoch(prices,period){
  if(!period)period=14;
  if(prices.length<period)return null;
  var sl=prices.slice(-period);
  var high=Math.max.apply(null,sl),low=Math.min.apply(null,sl),cur=prices[prices.length-1];
  if(high===low)return 50;
  return((cur-low)/(high-low))*100;
}

function detectPattern(prices){
  if(prices.length<4)return null;
  var l=prices.length,c1=prices[l-4],c2=prices[l-3],c3=prices[l-2],c4=prices[l-1];
  if(c4>c3&&c3>c2&&c2>c1)return{bias:'UP',strength:80};
  if(c4<c3&&c3<c2&&c2<c1)return{bias:'DOWN',strength:80};
  if(c3<c2&&c3<c1&&c4>c3)return{bias:'UP',strength:70};
  if(c3>c2&&c3>c1&&c4<c3)return{bias:'DOWN',strength:70};
  return null;
}

function analyzeSignal(){
  var prices=priceBuffer.slice();
  if(prices.length<30)return{signal:null,confidence:0,reason:'Collecting data ('+prices.length+'/30)',rsi:null,macd:null,stoch:null};
  var scores={UP:0,DOWN:0};
  var reasons=[];
  var rsi=calcRSI(prices);
  if(rsi!==null){
    if(rsi<30){scores.UP+=25;reasons.push('RSI oversold('+rsi.toFixed(1)+')');}
    else if(rsi>70){scores.DOWN+=25;reasons.push('RSI overbought('+rsi.toFixed(1)+')');}
    else if(rsi<45){scores.UP+=10;}
    else if(rsi>55){scores.DOWN+=10;}
  }
  var ema9=calcEMA(prices,9),ema21=calcEMA(prices,21);
  if(ema9!==null&&ema21!==null){
    var cur=prices[prices.length-1];
    if(ema9>ema21&&cur>ema9){scores.UP+=20;reasons.push('EMA bullish');}
    else if(ema9<ema21&&cur<ema9){scores.DOWN+=20;reasons.push('EMA bearish');}
  }
  var macd=calcMACD(prices);
  if(macd!==null){
    if(macd>0){scores.UP+=15;reasons.push('MACD+');}
    else{scores.DOWN+=15;reasons.push('MACD-');}
  }
  var bb=calcBB(prices,20);
  if(bb!==null){
    var c=prices[prices.length-1];
    if(c<=bb.lower){scores.UP+=20;reasons.push('BB lower');}
    else if(c>=bb.upper){scores.DOWN+=20;reasons.push('BB upper');}
  }
  var stoch=calcStoch(prices,14);
  if(stoch!==null){
    if(stoch<20){scores.UP+=15;reasons.push('Stoch oversold');}
    else if(stoch>80){scores.DOWN+=15;reasons.push('Stoch overbought');}
  }
  var pat=detectPattern(prices);
  if(pat){scores[pat.bias]+=pat.strength/4;reasons.push(pat.bias+' pattern');}
  var total=scores.UP+scores.DOWN;
  if(total===0)return{signal:null,confidence:0,reason:'No signal',rsi:rsi,macd:macd,stoch:stoch};
  var winner=scores.UP>=scores.DOWN?'UP':'DOWN';
  var confidence=Math.round((Math.max(scores.UP,scores.DOWN)/total)*100);
  return{signal:winner,confidence:confidence,upScore:scores.UP,downScore:scores.DOWN,reason:reasons.join(' | '),rsi:rsi,macd:macd,stoch:stoch};
}

var style=document.createElement('style');
style.textContent='#'+ROOT_ID+'{all:initial;font-family:Consolas,Monaco,monospace;}#'+ROOT_ID+' *{box-sizing:border-box;font-family:inherit;}#'+ROOT_ID+' .fab{position:fixed;z-index:2147483000;right:18px;bottom:90px;width:76px;display:flex;flex-direction:column;align-items:center;user-select:none;cursor:grab;touch-action:none;}#'+ROOT_ID+' .fab.glow{filter:drop-shadow(0 0 14px #00ff66) drop-shadow(0 0 30px rgba(0,255,102,.6));}#'+ROOT_ID+' .pulse{position:absolute;inset:-4px;border-radius:50%;border:1px solid rgba(0,255,136,.5);animation:aspPulse 2s ease-out infinite;pointer-events:none;}@keyframes aspPulse{0%{transform:scale(.9);opacity:.9;}100%{transform:scale(1.5);opacity:0;}}#'+ROOT_ID+' .icon{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#0a1a0f,#051208);border:2px solid #00ff88;box-shadow:0 0 14px rgba(0,255,136,.5);display:flex;align-items:center;justify-content:center;font-size:26px;position:relative;}#'+ROOT_ID+' .lbl{margin-top:5px;font-size:9px;font-weight:700;color:#00ff88;letter-spacing:.3px;text-align:center;white-space:nowrap;}#'+ROOT_ID+' .cbadge{position:absolute;top:-6px;right:-6px;background:#00ff88;color:#000;font-size:9px;font-weight:900;padding:2px 5px;border-radius:8px;min-width:28px;text-align:center;}#'+ROOT_ID+' .cbadge.low{background:#ff6b6b;}#'+ROOT_ID+' .cbadge.mid{background:#ffa500;}#'+ROOT_ID+' .panel{position:fixed;z-index:2147483001;width:min(320px,calc(100vw - 24px));left:50%;top:50%;transform:translate(-50%,-50%);background:linear-gradient(160deg,#030d06,#071510,#050d12);border:1px solid #00ff88;border-radius:12px;box-shadow:0 0 30px rgba(0,255,136,.2),0 16px 48px rgba(0,0,0,.6);color:#b8ffd0;display:none;}#'+ROOT_ID+' .panel.open{display:block;}#'+ROOT_ID+' .bk{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:none;}#'+ROOT_ID+' .bk.open{display:block;}#'+ROOT_ID+' .ph{padding:10px 14px;background:rgba(0,255,136,.07);border-bottom:1px solid rgba(0,255,136,.2);display:flex;align-items:center;justify-content:space-between;}#'+ROOT_ID+' .pt{font-size:13px;font-weight:700;color:#00ff88;}#'+ROOT_ID+' .pc{background:transparent;border:1px solid #00ff88;color:#00ff88;width:26px;height:26px;border-radius:4px;cursor:pointer;font-size:15px;}#'+ROOT_ID+' .pb{padding:14px;}#'+ROOT_ID+' .fld{margin-bottom:12px;}#'+ROOT_ID+' .fld label{display:block;font-size:10px;color:#7dffb0;text-transform:uppercase;letter-spacing:.7px;margin-bottom:5px;}#'+ROOT_ID+' .inp{width:100%;background:#040f08;border:1px solid #1a5c36;color:#e8ffe8;padding:8px 10px;border-radius:5px;font-size:13px;outline:none;}#'+ROOT_ID+' .inp:focus{border-color:#00ff88;}#'+ROOT_ID+' .dirs{display:flex;gap:8px;}#'+ROOT_ID+' .dir{flex:1;padding:10px 6px;border-radius:8px;border:1px solid rgba(0,255,102,.2);background:rgba(0,0,0,.3);color:#dfffe8;font-size:12px;font-weight:600;cursor:pointer;text-align:center;}#'+ROOT_ID+' .dir.active{background:rgba(0,255,102,.18);border-color:#00ff66;color:#00ff66;}#'+ROOT_ID+' .savebtn{width:100%;padding:12px;border-radius:5px;border:0;background:#00ff88;color:#030d06;font-weight:800;cursor:pointer;font-size:13px;margin-top:4px;}#'+ROOT_ID+' .sigbox{background:rgba(0,255,136,.05);border:1px solid rgba(0,255,136,.2);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:11px;line-height:1.7;}#'+ROOT_ID+' .sup{color:#00ff88;font-weight:700;}#'+ROOT_ID+' .sdn{color:#ff4444;font-weight:700;}#'+ROOT_ID+' .hint{font-size:10px;color:#5a8a68;text-align:center;margin-top:10px;}#'+ROOT_ID+' .scan{position:fixed;inset:0;z-index:2147483640;pointer-events:none;overflow:hidden;display:none;}#'+ROOT_ID+' .scan.on{display:block;}#'+ROOT_ID+' .scan-line{position:absolute;left:0;width:100%;height:4px;background:linear-gradient(180deg,#3ad67f,#00a050);box-shadow:0 -60px 100px rgba(0,220,115,1),0 -30px 60px rgba(0,200,100,.9),0 0 30px rgba(0,150,75,.8);top:-5%;animation:aspScan 1.4s linear infinite;}@keyframes aspScan{0%{top:-5%;}100%{top:105%;}}';
document.documentElement.appendChild(style);

var root=document.createElement('div');
root.id=ROOT_ID;
document.documentElement.appendChild(root);

var scanEl=document.createElement('div');
scanEl.className='scan';
scanEl.innerHTML='<div class="scan-line"></div>';
root.appendChild(scanEl);

var bk=document.createElement('div');
bk.className='bk';
root.appendChild(bk);

var fab=document.createElement('div');
fab.className='fab';
fab.innerHTML='<div class="pulse"></div><div class="icon"><span>🤖</span><div class="cbadge low" id="asp-cb">--</div></div><div class="lbl">ASP Smart Bot</div>';
root.appendChild(fab);

var panel=document.createElement('div');
panel.className='panel';
panel.innerHTML='<div class="ph"><div class="pt">⚡ ASP SMART BOT</div><button class="pc">\xd7</button></div><div class="pb"><div class="sigbox"><div>Signal: <span id="asp-sig">Analyzing...</span></div><div>Confidence: <span id="asp-c2">--</span></div><div>RSI: <span id="asp-rsi">--</span> | MACD: <span id="asp-macd">--</span> | Stoch: <span id="asp-st">--</span></div><div style="font-size:10px;color:#5a8a68;margin-top:4px;" id="asp-rsn">Waiting for price data...</div></div><div class="fld"><label>Delay before trade (sec)</label><input class="inp" id="asp-delay" type="number" min="1" max="120" value="5"/></div><div class="fld"><label>Min confidence to trade (%)</label><input class="inp" id="asp-mc" type="number" min="50" max="95" value="65"/></div><div class="fld"><label>Direction mode</label><div class="dirs" id="asp-dirs"><div class="dir active" data-dir="auto">Auto AI</div><div class="dir" data-dir="up">Force UP</div><div class="dir" data-dir="down">Force DOWN</div></div></div><div style="font-size:10px;color:#5a8a68;margin-bottom:10px;">Auto AI = RSI+EMA+MACD+BB+Stoch combined</div><button class="savebtn" id="asp-save">SAVE &amp; CLOSE</button><div class="hint">1 tap: start/stop · 3 taps: settings</div></div>';
root.appendChild(panel);

var cb=root.querySelector('#asp-cb');
var sigEl=root.querySelector('#asp-sig');
var c2El=root.querySelector('#asp-c2');
var rsiEl=root.querySelector('#asp-rsi');
var macdEl=root.querySelector('#asp-macd');
var stEl=root.querySelector('#asp-st');
var rsnEl=root.querySelector('#asp-rsn');
var delayInp=root.querySelector('#asp-delay');
var mcInp=root.querySelector('#asp-mc');
var dirBtns=root.querySelectorAll('#asp-dirs .dir');
var pendingDir=settings.direction||'auto';

function syncDirs(){Array.prototype.forEach.call(dirBtns,function(b){b.classList.toggle('active',b.getAttribute('data-dir')===pendingDir);});}
syncDirs();
Array.prototype.forEach.call(dirBtns,function(b){b.addEventListener('click',function(){pendingDir=b.getAttribute('data-dir');syncDirs();});});

function openPanel(){delayInp.value=settings.delaySec||5;mcInp.value=settings.minConfidence||65;pendingDir=settings.direction||'auto';syncDirs();bk.classList.add('open');panel.classList.add('open');}
function closePanel(){bk.classList.remove('open');panel.classList.remove('open');}
bk.addEventListener('click',closePanel);
panel.querySelector('.pc').addEventListener('click',closePanel);
root.querySelector('#asp-save').addEventListener('click',function(){
  settings.delaySec=Math.max(1,Math.min(120,parseInt(delayInp.value)||5));
  settings.minConfidence=Math.max(50,Math.min(95,parseInt(mcInp.value)||65));
  settings.direction=pendingDir;
  saveSettings(settings);
  closePanel();
});

function updateDisplay(a){
  if(!a)return;
  if(a.signal==='UP'){sigEl.textContent='▲ UP';sigEl.className='sup';}
  else if(a.signal==='DOWN'){sigEl.textContent='▼ DOWN';sigEl.className='sdn';}
  else{sigEl.textContent='WAIT';sigEl.className='';}
  var c=a.confidence||0;
  c2El.textContent=c+'%';
  if(a.rsi!==null&&a.rsi!==undefined)rsiEl.textContent=a.rsi.toFixed(1);
  if(a.macd!==null&&a.macd!==undefined)macdEl.textContent=a.macd.toFixed(5);
  if(a.stoch!==null&&a.stoch!==undefined)stEl.textContent=a.stoch.toFixed(1);
  if(rsnEl)rsnEl.textContent=a.reason||'';
  cb.textContent=c+'%';
  cb.className='cbadge';
  if(c<60)cb.classList.add('low');
  else if(c<75)cb.classList.add('mid');
}

var sigTimer=null;
function startSigUpdate(){
  if(sigTimer)return;
  sigTimer=setInterval(function(){var a=analyzeSignal();updateDisplay(a);lastSignal=a;},2000);
}

function getTradeButtons(){
  var wrap=document.querySelector('#trade-button');
  if(!wrap)return{up:null,down:null};
  var btns=Array.prototype.slice.call(wrap.querySelectorAll('button'));
  var up=btns.find(function(b){return/up/i.test(b.textContent||'')||b.classList.contains('JQZcs');})||wrap.querySelector('button.JQZcs');
  var dn=btns.find(function(b){return/down/i.test(b.textContent||'')||b.classList.contains('twQq3');})||wrap.querySelector('button.twQq3');
  return{up:up,down:dn};
}

var state={running:false,timer:null};

function placeTrade(){
  var a=analyzeSignal();lastSignal=a;updateDisplay(a);
  var dir=settings.direction||'auto';
  var btns=getTradeButtons();
  var btn=null;
  if(dir==='up'){btn=btns.up;}
  else if(dir==='down'){btn=btns.down;}
  else{
    var mc=settings.minConfidence||65;
    if(!a.signal||a.confidence<mc){
      console.log('[ASP] Weak signal ('+a.confidence+'%) — skip');
      scheduleNext();return;
    }
    btn=a.signal==='UP'?btns.up:btns.down;
    console.log('[ASP] Signal:',a.signal,'| Conf:',a.confidence+'%','|',a.reason);
  }
  if(btn)btn.click();
  else console.error('[ASP] Button not found');
  scheduleNext();
}

function scheduleNext(){if(!state.running)return;state.timer=setTimeout(placeTrade,settings.delaySec*1000);}
function startBot(){if(state.running)return;state.running=true;fab.classList.add('glow');scanEl.classList.add('on');startSigUpdate();state.timer=setTimeout(placeTrade,settings.delaySec*1000);}
function stopBot(){state.running=false;if(state.timer){clearTimeout(state.timer);state.timer=null;}fab.classList.remove('glow');scanEl.classList.remove('on');}

var tapCount=0,lastTap=0,tapTimer=null;
function registerTap(){
  if(panel.classList.contains('open'))return;
  var now=Date.now();
  if(now-lastTap>650)tapCount=0;
  lastTap=now;tapCount++;
  if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}
  if(tapCount>=3){tapCount=0;openPanel();return;}
  tapTimer=setTimeout(function(){tapTimer=null;if(tapCount===1){if(state.running)stopBot();else startBot();}tapCount=0;},380);
}

var drag={on:false,moved:false,sx:0,sy:0,sl:0,st:0};
function onDown(cx,cy){drag.on=true;drag.moved=false;var r=fab.getBoundingClientRect();drag.sx=cx;drag.sy=cy;drag.sl=r.left;drag.st=r.top;fab.style.right='auto';fab.style.bottom='auto';fab.style.left=drag.sl+'px';fab.style.top=drag.st+'px';}
function onMove(cx,cy){if(!drag.on)return;var dx=cx-drag.sx,dy=cy-drag.sy;if(Math.abs(dx)>8||Math.abs(dy)>8)drag.moved=true;var r=fab.getBoundingClientRect();fab.style.left=Math.max(0,Math.min(drag.sl+dx,window.innerWidth-r.width))+'px';fab.style.top=Math.max(0,Math.min(drag.st+dy,window.innerHeight-r.height))+'px';}
function onUp(){if(!drag.on)return;drag.on=false;if(!drag.moved)registerTap();}
fab.addEventListener('mousedown',function(e){e.preventDefault();onDown(e.clientX,e.clientY);});
fab.addEventListener('touchstart',function(e){if(e.touches.length!==1)return;e.preventDefault();onDown(e.touches[0].clientX,e.touches[0].clientY);},{passive:false});
document.addEventListener('mousemove',function(e){onMove(e.clientX,e.clientY);});
document.addEventListener('touchmove',function(e){if(!drag.on||e.touches.length!==1)return;e.preventDefault();onMove(e.touches[0].clientX,e.touches[0].clientY);},{passive:false});
document.addEventListener('mouseup',onUp);
document.addEventListener('touchend',onUp);
document.addEventListener('touchcancel',onUp);

function destroy(){stopBot();if(sigTimer){clearInterval(sigTimer);sigTimer=null;}if(domPriceTimer){clearInterval(domPriceTimer);domPriceTimer=null;}closePanel();if(style.parentNode)style.parentNode.removeChild(style);if(root.parentNode)root.parentNode.removeChild(root);delete window.__ASP_BOT__;}
window.__ASP_BOT__={destroy:destroy,start:startBot,stop:stopBot,state:state,analyze:analyzeSignal};

interceptWebSocket();
startDOMPriceFallback();
startSigUpdate();
console.log('%c[ASP Smart Bot] Ready','color:#00ff88;font-weight:bold');
})();
