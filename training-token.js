const crypto = require('crypto');
const FEATURES = ['practice', 'game'];
const TTL = 30 * 60;
function fail() { const e = new Error('Training sign-in expired or unavailable. Reopen training from Aira.'); e.status = 401; throw e; }
function createTrainingToken({ admin, features, locationIds, secret, now = Math.floor(Date.now()/1000) }) {
  if (!secret || !admin?.id || !admin?.email || !features?.length || features.some(f => !FEATURES.includes(f))) fail();
  const payload = { iss:'aira-api', aud:'aira-training', sub:String(admin.id), email:admin.email.toLowerCase(), name:admin.name || '', features, location_ids:locationIds || [], all_locations:admin.role==='super_admin', iat:now, exp:now+TTL };
  const input = [ {alg:'HS256',typ:'AIRA-TRAINING'}, payload ].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return { token:input+'.'+crypto.createHmac('sha256',secret).update(input).digest('base64url'), expires_at:new Date(payload.exp*1000).toISOString() };
}
function verifyTrainingToken(token, secret, now = Math.floor(Date.now()/1000)) {
  try {
    if (!secret || typeof token !== 'string' || token.length>8192) fail();
    const parts=token.split('.'); if(parts.length!==3) fail();
    const expected=crypto.createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest();
    const got=Buffer.from(parts[2],'base64url');
    if(got.length!==expected.length || !crypto.timingSafeEqual(got,expected)) fail();
    const h=JSON.parse(Buffer.from(parts[0],'base64url')); const p=JSON.parse(Buffer.from(parts[1],'base64url'));
    if(h.alg!=='HS256'||h.typ!=='AIRA-TRAINING'||p.iss!=='aira-api'||p.aud!=='aira-training'||typeof p.sub!=='string'||!p.sub||typeof p.email!=='string'||!p.email||!Array.isArray(p.features)||!p.features.length||p.features.some(f=>!FEATURES.includes(f))||!Array.isArray(p.location_ids)||!Number.isInteger(p.exp)||!Number.isInteger(p.iat)||p.exp<=now||p.iat>now+30||p.exp-p.iat>TTL) fail();
    return p;
  } catch { fail(); }
}
module.exports={createTrainingToken,verifyTrainingToken};
