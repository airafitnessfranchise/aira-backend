const {verifyTrainingToken}=require('./training-token');
const TRAINING_PATHS=['/practice','/airafitnessclosinggame'];
function bootstrap(token) {
  // Token is server-verified; escaping also prevents closing the script element.
  const encoded=JSON.stringify(token).replace(/</g,'\\u003c');
  return `<script>(function(){const token=${encoded};const current=new URL(location.href);current.searchParams.delete('training_token');history.replaceState(null,'',current.pathname+current.search+current.hash);const original=window.fetch.bind(window);window.fetch=function(input,options){const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin===location.origin&&(/^\\/(practice|airafitnessclosinggame)(\\/|$)/).test(url.pathname)){options=Object.assign({},options);const headers=new Headers(options.headers||(typeof input!=='string'?input.headers:undefined));headers.set('Authorization','Bearer '+token);options.headers=headers;}return original(input,options);};document.addEventListener('click',function(event){const a=event.target.closest&&event.target.closest('a[href]');if(!a)return;const url=new URL(a.href,location.href);if(url.origin===location.origin&&(/^\\/(practice|airafitnessclosinggame)(\\/|$)/).test(url.pathname)){url.searchParams.set('training_token',token);a.href=url.href;}},true);})();</script>`;
}
function createTrainingSecurity({secret, getSession, reserveUsage, canonicalLocationId, getPlayerById}) {
  let active=0; const actors=new Set();
  function auth(req,res,next) {
    res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');
    const token=/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || (req.method==='GET' ? req.query.training_token : null);
    try { req.training=verifyTrainingToken(token,secret());req.trainingToken=token; }
    catch { return res.status(401).send('Sign in to Aira, then open Training from the dashboard or Staff app.'); }
    if(req.method==='POST' && req.body?.location_id && !req.training.all_locations && !req.training.location_ids.map(canonicalLocationId).includes(canonicalLocationId(req.body.location_id))) return res.status(403).json({ok:false,error:'Choose one of your assigned gyms.'});
    const fullPath=req.originalUrl.split('?')[0].toLowerCase();
    if(fullPath.startsWith('/airafitnessclosinggame')&&!req.training.features.includes('game')) return res.status(403).json({ok:false,error:'Closing Game access is not enabled.'});
    if(fullPath==='/practice'&&!req.training.features.includes('practice')) return res.status(403).json({ok:false,error:'Practice Bot access is not enabled.'});
    const send=res.send;
    res.send=function(body){if(typeof body==='string' && /<head>/i.test(body))body=body.replace(/<head>/i,'<head>'+bootstrap(token));return send.call(this,body);};
    next();
  }
  function action(kind) { return async(req,res,next)=>{
    const t=req.training;const b=req.body || {};
    const feature=b.mode==='game'?'game':'practice';
    if((kind==='start'||kind==='voice')&&!t.features.includes(kind==='voice'?'practice':feature)) return res.status(403).json({ok:false,error:'Training access is not enabled.'});
    let session;
    if(kind==='turn'||kind==='end') {
      session=typeof b.session_id==='string'?getSession(b.session_id):null;
      if(!session||session.owner_id!==t.sub||!t.features.includes(session.training_feature)||session.started_at<Date.now()-30*60*1000)return res.status(404).json({ok:false,error:'Training session expired. Please start again.'});
      if(session.scoring_attempted)return res.status(409).json({ok:false,error:'This session has already been submitted. Start a new practice.'});
      if(kind==='turn' && session.messages.length>=79)return res.status(400).json({ok:false,error:'Practice session is full. Please finish and start a new session.'});
    }
    if(kind==='turn'&&(typeof b.message!=='string'||!b.message.trim()||b.message.length>2000))return res.status(400).json({ok:false,error:'Enter a message of 1–2,000 characters.'});
    if(kind==='end'&&b.messages!==undefined) {
      if(!Array.isArray(b.messages)||b.messages.length>80||b.messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>2000)||JSON.stringify(b.messages).length>50000)return res.status(400).json({ok:false,error:'Practice transcript is too large or invalid.'});
    }
    if(kind==='turn'&&JSON.stringify(session.messages).length+b.message.length>50000)return res.status(400).json({ok:false,error:'Practice transcript is full. Please finish this session.'});
    if(kind==='start'||kind==='voice') {
      if(['player_name','scenario_id','location_id'].some(k=>b[k]!=null&&(typeof b[k]!=='string'||b[k].length>200)))return res.status(400).json({ok:false,error:'Invalid practice details.'});
      if(b.location_id&&!t.all_locations&&!t.location_ids.map(canonicalLocationId).includes(canonicalLocationId(b.location_id)))return res.status(403).json({ok:false,error:'Choose one of your assigned gyms.'});
      b.player_name=t.name || t.email;
      if(b.player_id) {
        const player=await getPlayerById(b.player_id).catch(()=>null);
        if(!player||player.email?.toLowerCase()!==t.email)return res.status(403).json({ok:false,error:'Reopen the Closing Game to confirm your player account.'});
      }
    }
    if(actors.has(t.sub)||active>=4){res.set('Retry-After','10');return res.status(429).json({ok:false,error:'Training is busy. Please try again shortly.'});}
    actors.add(t.sub);active++;
    let released=false;let timer;
    const release=()=>{if(!released){released=true;active--;actors.delete(t.sub);clearTimeout(timer);}};
    // Provider calls time out in 45 seconds; hold the slot across client disconnects.
    timer=setTimeout(release,60000);timer.unref?.();res.once('finish',release);
    try {
      const result=await reserveUsage(req.trainingToken,kind);
      if(!result.allowed){release();if(result.retry_after_seconds)res.set('Retry-After',String(result.retry_after_seconds));return res.status(result.status || 503).json({ok:false,error:result.error || 'Training is temporarily unavailable.'});}
      if(kind==='end' && (Array.isArray(b.messages)?b.messages.length:session.messages.length)>=4)session.scoring_attempted=true;
      req.trainingFeature=feature;next();
    } catch { release();res.status(503).json({ok:false,error:'Training limits are temporarily unavailable.'}); }
  }; }
  return {auth,action};
}
module.exports={createTrainingSecurity,bootstrap,TRAINING_PATHS};
