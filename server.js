/* QueueHub backend: SQLite is the source of truth for public queues and queue actions.
   The browser may keep UI/session state in localStorage, but tokens, service status,
   service records, notifications, and queue history live in SQLite and are broadcast
   over WebSockets to every connected customer/staff screen. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DB_FILE = process.env.QUEUEFLOW_DB_FILE || path.join(ROOT, 'queueflow.sqlite');
const db = new Database(DB_FILE);
const clients = new Map();

const uid = prefix => `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const clone = value => JSON.parse(JSON.stringify(value));
const roomKey = (orgSlug, serviceSlug) => `${orgSlug}::${serviceSlug}`;
function json(res, status, payload) { const body = JSON.stringify(payload); res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'GET,PUT,POST,DELETE,OPTIONS' }); res.end(body); }
function text(res, status, body, type='text/plain; charset=utf-8') { res.writeHead(status, { 'Content-Type':type, 'Cache-Control':'no-cache' }); res.end(body); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); }); req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } }); req.on('error', reject); }); }
function safeJson(value, fallback) { try { return JSON.parse(value); } catch (_) { return fallback; } }

// Schema: organizations/users/services are configuration, queue_entries is the
// shared queue, and notifications/history retain the operational audit trail.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT, contact TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT, role TEXT NOT NULL, last_seen TEXT);
  CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT, category TEXT, prefix TEXT, published INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, demo_open INTEGER NOT NULL DEFAULT 0, queue_generation INTEGER NOT NULL DEFAULT 1, schedule_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(organization_id, slug));
  CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL, phone TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(organization_id, phone));
  CREATE TABLE IF NOT EXISTS queue_entries (id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, service_date TEXT NOT NULL, number INTEGER NOT NULL, token TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL, counter INTEGER, joined_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, service_minutes INTEGER, priority_requested INTEGER NOT NULL DEFAULT 0, priority_approved INTEGER NOT NULL DEFAULT 0, last_recalled_at TEXT, queue_generation INTEGER NOT NULL DEFAULT 1, UNIQUE(service_id, service_date, number), UNIQUE(service_id, service_date, token));
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, entry_id TEXT REFERENCES queue_entries(id) ON DELETE CASCADE, type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT);
  CREATE TABLE IF NOT EXISTS queue_history (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, entry_id TEXT REFERENCES queue_entries(id) ON DELETE SET NULL, action TEXT NOT NULL, details_json TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_entries_service_date ON queue_entries(service_id, service_date, number);
  CREATE INDEX IF NOT EXISTS idx_notifications_entry ON notifications(entry_id, created_at);
`);
try { db.exec('ALTER TABLE queue_entries ADD COLUMN customer_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE queue_entries ADD COLUMN grace_started_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE services ADD COLUMN queue_generation INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE queue_entries ADD COLUMN queue_generation INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
db.prepare('UPDATE services SET queue_generation=1 WHERE queue_generation IS NULL OR queue_generation < 1').run();
db.prepare('UPDATE queue_entries SET queue_generation=1 WHERE queue_generation IS NULL OR queue_generation < 1').run();

const DEFAULT_GRACE_SECONDS = 120;
function serviceGraceSeconds(service) {
  const schedule = safeJson(service?.schedule_json, service?.schedule || {});
  return Math.max(30, Number(schedule.graceSeconds || DEFAULT_GRACE_SECONDS));
}

function upsertOrganization(org) {
  const id = org.id || uid('org');
  db.prepare(`INSERT INTO organizations(id,slug,name,category,contact,created_at) VALUES(@id,@slug,@name,@category,@contact,@createdAt)
    ON CONFLICT(slug) DO UPDATE SET name=excluded.name, category=excluded.category, contact=excluded.contact`).run({ id, slug:org.slug, name:org.name, category:org.category || '', contact:org.contact || '', createdAt:org.createdAt || new Date().toISOString() });
  return db.prepare('SELECT * FROM organizations WHERE slug=?').get(org.slug);
}
function upsertUsers(org, dbOrg) {
  for (const user of (org.users || [])) db.prepare(`INSERT INTO users(id,organization_id,name,email,password,role,last_seen) VALUES(@id,@orgId,@name,@email,@password,@role,@lastSeen)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, role=excluded.role, last_seen=excluded.last_seen`).run({ id:user.id || uid('usr'), orgId:dbOrg.id, name:user.name || 'User', email:user.email || uid('email'), password:user.password || null, role:user.role || 'staff', lastSeen:user.lastSeen || null });
}
function upsertService(org, dbOrg, incoming) {
  const service = incoming; const schedule = service.schedule || {};
  const existingService = db.prepare('SELECT queue_generation FROM services WHERE organization_id=? AND (id=? OR slug=?)').get(dbOrg.id, service.id || '', service.slug);
  const queueGeneration = existingService ? Number(existingService.queue_generation || 1) : Number(service.queueGeneration || 1);
  db.prepare(`INSERT INTO services(id,organization_id,slug,name,description,category,prefix,published,paused,demo_open,queue_generation,schedule_json,created_at) VALUES(@id,@orgId,@slug,@name,@description,@category,@prefix,@published,@paused,@demoOpen,@queueGeneration,@schedule,@createdAt)
    ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, name=excluded.name, description=excluded.description, category=excluded.category, prefix=excluded.prefix, published=excluded.published, paused=excluded.paused, demo_open=excluded.demo_open, queue_generation=excluded.queue_generation, schedule_json=excluded.schedule_json`).run({ id:service.id || uid('svc'), orgId:dbOrg.id, slug:service.slug, name:service.name, description:service.description || '', category:service.category || '', prefix:service.prefix || String(service.name || 'Q').slice(0,1).toUpperCase(), published:service.published ? 1 : 0, paused:service.paused ? 1 : 0, demoOpen:service.demoOpen ? 1 : 0, queueGeneration, schedule:JSON.stringify(schedule), createdAt:service.createdAt || new Date().toISOString() });
  const dbService = db.prepare('SELECT * FROM services WHERE organization_id=? AND slug=?').get(dbOrg.id, service.slug);
  for (const token of (service.tokens || [])) {
    // Existing queue entries are authoritative in SQLite. Sync only entries that
    // are not present yet so a stale browser cannot overwrite a live status.
    db.prepare(`INSERT OR IGNORE INTO queue_entries(id,service_id,service_date,number,token,customer_name,phone,status,counter,joined_at,started_at,completed_at,service_minutes,priority_requested,priority_approved,last_recalled_at,queue_generation)
      VALUES(@id,@serviceId,@date,@number,@token,@customerName,@phone,@status,@counter,@joinedAt,@startedAt,@completedAt,@serviceMinutes,@priorityRequested,@priorityApproved,@lastRecalledAt,@queueGeneration)`).run({ id:token.id || uid('tok'), serviceId:dbService.id, date:token.date || todayISO(), number:Number(token.number || 0), token:token.token, customerName:token.customerName || 'Customer', phone:token.phone || '', status:token.status || 'waiting', counter:token.counter || null, joinedAt:token.joinedAt || new Date().toISOString(), startedAt:token.startedAt || null, completedAt:token.completedAt || null, serviceMinutes:token.serviceMinutes || null, priorityRequested:token.priorityRequested ? 1 : 0, priorityApproved:token.priorityApproved ? 1 : 0, lastRecalledAt:token.lastRecalledAt || null, queueGeneration:Number(token.queueGeneration || dbService.queue_generation || 1) });
  }
  return dbService;
}
function dbToken(row) { return { id:row.id, date:row.service_date, number:row.number, token:row.token, customerName:row.customer_name, phone:row.phone, status:row.status, counter:row.counter, joinedAt:row.joined_at, startedAt:row.started_at, graceStartedAt:row.grace_started_at || row.started_at, completedAt:row.completed_at, serviceMinutes:row.service_minutes, priorityRequested:Boolean(row.priority_requested), priorityApproved:Boolean(row.priority_approved), lastRecalledAt:row.last_recalled_at, queueGeneration:Number(row.queue_generation || 1) }; }
function recordBySlugs(orgSlug, serviceSlug) {
  const org = db.prepare('SELECT * FROM organizations WHERE slug=?').get(orgSlug); if (!org) return null;
  const service = db.prepare('SELECT * FROM services WHERE organization_id=? AND slug=?').get(org.id, serviceSlug); if (!service) return null;
  const tokens = db.prepare('SELECT * FROM queue_entries WHERE service_id=? ORDER BY service_date DESC, number ASC').all(service.id).map(dbToken);
  const notifications = db.prepare('SELECT * FROM notifications WHERE service_id=? ORDER BY created_at DESC LIMIT 100').all(service.id).map(n => ({ id:n.id, entryId:n.entry_id, type:n.type, message:n.message, createdAt:n.created_at, readAt:n.read_at }));
  const history = db.prepare('SELECT * FROM queue_history WHERE service_id=? ORDER BY created_at DESC LIMIT 200').all(service.id).map(h => ({ id:h.id, entryId:h.entry_id, action:h.action, details:safeJson(h.details_json, {}), createdAt:h.created_at }));
  return { organization:{ id:org.id, name:org.name, slug:org.slug, category:org.category, contact:org.contact || '' }, service:{ id:service.id, slug:service.slug, name:service.name, description:service.description || '', category:service.category || '', prefix:service.prefix, published:Boolean(service.published), paused:Boolean(service.paused), demoOpen:Boolean(service.demo_open), queueGeneration:Number(service.queue_generation || 1), schedule:safeJson(service.schedule_json, {}), tokens, notifications, history, createdAt:service.created_at } };
}
function notify(orgId, serviceId, entryId, type, message) {
  const duplicate = ['approaching','next'].includes(type)
    ? db.prepare('SELECT id FROM notifications WHERE service_id=? AND entry_id IS ? AND type=? LIMIT 1').get(serviceId, entryId || null, type)
    : db.prepare('SELECT id FROM notifications WHERE service_id=? AND entry_id IS ? AND type=? AND message=? LIMIT 1').get(serviceId, entryId || null, type, message);
  if (duplicate) return false;
  db.prepare('INSERT INTO notifications(id,organization_id,service_id,entry_id,type,message,created_at) VALUES(?,?,?,?,?,?,?)').run(uid('note'), orgId, serviceId, entryId || null, type, message, new Date().toISOString());
  return true;
}
function history(orgId, serviceId, entryId, action, details={}) { db.prepare('INSERT INTO queue_history(id,organization_id,service_id,entry_id,action,details_json,created_at) VALUES(?,?,?,?,?,?,?)').run(uid('hist'), orgId, serviceId, entryId || null, action, JSON.stringify(details), new Date().toISOString()); }
function notifyQueueSignals(orgId, serviceId, date) {
  const entries = db.prepare("SELECT * FROM queue_entries WHERE service_id=? AND service_date=? AND status IN ('waiting','called','recalled') ORDER BY priority_approved DESC, number ASC").all(serviceId, date);
  entries.forEach((entry, index) => {
    if (entry.status === 'called' || entry.status === 'recalled') return;
    const ahead = index;
    const type = ahead === 0 ? 'next' : 'approaching';
    const message = ahead === 0 ? `Token ${entry.token} is next. Please be ready.` : `Token ${entry.token} is approaching with ${ahead} ${ahead === 1 ? 'person' : 'people'} ahead.`;
    notify(orgId, serviceId, entry.id, type, message);
  });
}
function refreshServiceQueue(orgId, service, reason = 'service_updated') {
  const currentGeneration = Math.max(1, Number(service.queue_generation || 1));
  const nextGeneration = currentGeneration + 1;
  const now = new Date().toISOString();
  const active = db.prepare("SELECT id, token, status FROM queue_entries WHERE service_id=? AND status IN ('waiting','called','recalled')").all(service.id);
  db.prepare('UPDATE services SET queue_generation=? WHERE id=?').run(nextGeneration, service.id);
  db.prepare("UPDATE queue_entries SET status='cancelled', completed_at=? WHERE service_id=? AND status IN ('waiting','called','recalled')").run(now, service.id);
  active.forEach(entry => history(orgId, service.id, entry.id, 'service_refresh', { token: entry.token, previousStatus: entry.status, queueGeneration: nextGeneration, reason }));
  notify(orgId, service.id, null, 'queue-reset', 'This service was updated. A fresh queue is now open for new customers.');
  return nextGeneration;
}
function broadcast(orgSlug, serviceSlug) { const record = recordBySlugs(orgSlug, serviceSlug); if (!record) return; const payload = JSON.stringify({ type:'queue.updated', ...record }); const room = clients.get(roomKey(orgSlug, serviceSlug)); if (!room) return; for (const socket of room) if (socket.readyState === 1) socket.send(payload); }
function broadcastOrganizationDeleted(orgSlug) {
  for (const [key, room] of clients.entries()) {
    if (!key.startsWith(`${orgSlug}::`)) continue;
    const payload = JSON.stringify({ type:'organization.deleted', orgSlug });
    for (const socket of room) if (socket.readyState === 1) { socket.send(payload); socket.close(1000, 'Organization deleted'); }
    clients.delete(key);
  }
}
function runTransaction(fn) { return db.transaction(fn)(); }

function seedDemo() {
  runTransaction(() => {
    const org = upsertOrganization({ id:'org_ramesh_demo', slug:'ramesh-student-service-center', name:'Ramesh Student Service Center', category:'College / University', contact:'+91 98765 43210', createdAt:new Date().toISOString(), users:[{id:'usr_ramesh_admin',name:'Ramesh Admin',email:'admin@demo.com',password:'Admin123',role:'admin'},{id:'usr_amit_staff',name:'Amit Staff',email:'staff@demo.com',password:'Staff123',role:'staff'},{id:'usr_priya_staff',name:'Priya Staff',email:'priya@demo.com',password:'Staff123',role:'staff'}] });
    upsertUsers({ users:[{id:'usr_ramesh_admin',name:'Ramesh Admin',email:'admin@demo.com',password:'Admin123',role:'admin'},{id:'usr_amit_staff',name:'Amit Staff',email:'staff@demo.com',password:'Staff123',role:'staff'},{id:'usr_priya_staff',name:'Priya Staff',email:'priya@demo.com',password:'Staff123',role:'staff'}] }, org);
    const schedule = { type:'recurring', dates:[], days:[0,1,2,3,4,5], openingTime:'00:00', startTime:'00:00', closingTime:'23:59', cutoffTime:'23:59', maxTokens:150, counters:1, avgMinutes:7, notifications:true };
    const services = [
      { id:'svc_ramesh_certificate', slug:'student-certificate', name:'Student Certificate', description:'Apply for bonafide, character, and other student certificates.', category:'Student services', prefix:'SC', published:true, demoOpen:true, schedule },
      { id:'svc_ramesh_scholarship', slug:'scholarship-application', name:'Scholarship Application', description:'Submit and track scholarship application documents.', category:'Student services', prefix:'SA', published:true, schedule:{...schedule,avgMinutes:10} },
      { id:'svc_ramesh_exam', slug:'examination-support', name:'Examination Support', description:'Get help with examination forms and records.', category:'Student services', prefix:'EX', published:true, schedule:{...schedule,avgMinutes:8} },
      { id:'svc_ramesh_idcard', slug:'id-card-service', name:'ID Card Service', description:'Apply for a new or replacement student ID card.', category:'Student services', prefix:'ID', published:true, schedule:{...schedule,avgMinutes:5} }
    ];
    services.forEach(service => upsertService({ users:[] }, org, { ...service, tokens:[] }));
    const demoCertificate = db.prepare('SELECT id FROM services WHERE organization_id=? AND slug=?').get(org.id, 'student-certificate');
    if (demoCertificate && !db.prepare('SELECT 1 FROM queue_entries WHERE service_id=? LIMIT 1').get(demoCertificate.id)) resetDemoEntries(false);
    // Backward-compatible public VSSUT service for the existing QueueHub demo link.
    const vssut = upsertOrganization({ id:'org_demo_vssut', slug:'vssut-student-services', name:'VSSUT Student Services', category:'College / University', contact:'+91 98765 43210', createdAt:new Date().toISOString() });
    upsertService({ users:[] }, vssut, { id:'svc_demo_bonafide', slug:'bonafide-certificate', name:'Bonafide Certificate', description:'Apply for a Bonafide Certificate without waiting in the corridor.', category:'Student services', prefix:'B', published:true, demoOpen:true, schedule:{ type:'specific', dates:[todayISO()], days:[], openingTime:'09:00', startTime:'10:00', closingTime:'16:00', cutoffTime:'15:30', maxTokens:150, counters:2, avgMinutes:4, notifications:true }, tokens:[] });
    const vservice = db.prepare('SELECT id FROM services WHERE organization_id=? AND slug=?').get(vssut.id,'bonafide-certificate');
    if (!db.prepare('SELECT 1 FROM queue_entries WHERE service_id=? LIMIT 1').get(vservice.id)) {
      [['B001','Riya Sen','waiting'],['B002','Kabir Rao','waiting'],['B003','Meera Nair','called'],['B004','Arjun Patnaik','waiting'],['B005','Sara Khan','waiting']].forEach((item,index) => db.prepare(`INSERT INTO queue_entries(id,service_id,service_date,number,token,customer_name,phone,status,counter,joined_at,started_at,completed_at,service_minutes,priority_requested,priority_approved) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`tok_demo_${index+1}`,vservice.id,todayISO(),index+1,item[0],item[1],`90000000${index}`,item[2],item[2]==='called'?2:null,new Date(Date.now()-(index+1)*8*60000).toISOString(),item[2]==='called'?new Date(Date.now()-5*60000).toISOString():null,null,null,0,0));
    }
  });
}
function resetDemoEntries(broadcastAfter=true) {
  const service = db.prepare('SELECT s.*,o.id AS org_id,o.slug AS org_slug FROM services s JOIN organizations o ON o.id=s.organization_id WHERE o.slug=? AND s.slug=?').get('ramesh-student-service-center','student-certificate'); if (!service) return;
  const work = () => {
    db.prepare('DELETE FROM queue_entries WHERE service_id=?').run(service.id); db.prepare('DELETE FROM notifications WHERE service_id=?').run(service.id); db.prepare('DELETE FROM queue_history WHERE service_id=?').run(service.id);
    const date=todayISO(); const now=new Date().toISOString(); const rows=[['SC001','Rahul','called'],['SC002','Anita','waiting'],['SC003','Suresh','waiting'],['SC004','Priya','waiting'],['SC005','Arjun','waiting'],['SC006','Neha','waiting'],['SC007','Kiran','waiting'],['SC008','Meena','waiting']];
    rows.forEach((item,index)=>db.prepare(`INSERT INTO queue_entries(id,service_id,service_date,number,token,customer_name,phone,status,counter,joined_at,started_at,completed_at,service_minutes,priority_requested,priority_approved,queue_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`tok_ramesh_${index+1}`,service.id,date,index+1,item[0],item[1],`91000000${index}`,item[2],item[2]==='called'?1:null,now,item[2]==='called'?now:null,null,null,0,0,Number(service.queue_generation || 1)));
    notify(service.org_id,service.id,'tok_ramesh_1','called','Token SC001 is now being served.'); history(service.org_id,service.id,'tok_ramesh_1','reset',{demo:true});
  };
  if (db.inTransaction) work(); else runTransaction(work);
  if (broadcastAfter) broadcast('ramesh-student-service-center','student-certificate');
}
seedDemo();

async function handleApi(req,res,url) {
  if (req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,PUT,POST,DELETE,OPTIONS'}); return res.end(); }
  if (req.method==='POST' && url.pathname==='/api/demo/reset') { resetDemoEntries(true); return json(res,200,recordBySlugs('ramesh-student-service-center','student-certificate')); }
  if ((req.method==='DELETE' && url.pathname.startsWith('/api/shared/organizations/')) || (req.method==='POST' && url.pathname.startsWith('/api/shared/organizations/') && url.pathname.endsWith('/delete'))) {
    const rawOrgPath = url.pathname.slice('/api/shared/organizations/'.length).replace(/\/delete$/, '');
    const orgSlug = decodeURIComponent(rawOrgPath);
    const body = await readBody(req);
    const org = db.prepare('SELECT * FROM organizations WHERE slug=? AND id=?').get(orgSlug, body.organizationId || '');
    const admin = org && db.prepare("SELECT id FROM users WHERE id=? AND organization_id=? AND role='admin' AND password=?").get(body.userId || '', org.id, String(body.password || ''));
    if (!org || !admin) return json(res, 403, { error:'Only the current organization administrator can delete this organization.' });
    runTransaction(() => { db.prepare('DELETE FROM organizations WHERE id=?').run(org.id); });
    broadcastOrganizationDeleted(org.slug);
    return json(res, 200, { deleted:true, organizationId:org.id, slug:org.slug });
  }
  if (req.method==='PUT' && url.pathname==='/api/shared/organizations/sync') { const body=await readBody(req); if(!body.organization?.slug) return json(res,400,{error:'Organization is required'}); const result=runTransaction(()=>{ const org=upsertOrganization(body.organization); upsertUsers(body.organization,org); for(const service of (body.organization.services||[])) upsertService(body.organization,org,service); return {id:org.id,name:org.name,slug:org.slug,category:org.category,contact:org.contact||''}; }); return json(res,200,result); }
  if (req.method==='POST' && url.pathname==='/api/auth/login') { const body=await readBody(req); const row=db.prepare('SELECT u.*,o.id AS org_id,o.name AS org_name,o.slug AS org_slug,o.category AS org_category,o.contact AS org_contact FROM users u JOIN organizations o ON o.id=u.organization_id WHERE lower(u.email)=lower(?) AND u.password=?').get(String(body.email||''),String(body.password||'')); if(!row) return json(res,401,{error:'Invalid credentials'}); db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(new Date().toISOString(),row.id); return json(res,200,{user:{id:row.id,name:row.name,email:row.email,role:row.role},organization:{id:row.org_id,name:row.org_name,slug:row.org_slug,category:row.org_category,contact:row.org_contact||''}}); }
  const match=url.pathname.match(/^\/api\/shared\/services\/([^/]+)\/([^/]+)(?:\/(join|action))?$/); if (!match) return json(res,404,{error:'Not found'});
  const orgSlug=decodeURIComponent(match[1]); const serviceSlug=decodeURIComponent(match[2]); const operation=match[3];
  try {
    if (req.method==='GET' && !operation) { const record=recordBySlugs(orgSlug,serviceSlug); return record ? json(res,200,record) : json(res,404,{error:'Service not found'}); }
    if (req.method==='PUT' && !operation) {
      const body=await readBody(req);
      if(!body.organization?.slug || !body.service?.slug) return json(res,400,{error:'Organization and service are required'});
      const record=runTransaction(()=>{
        const org=upsertOrganization(body.organization);
        upsertUsers(body.organization,org);
        const existing=db.prepare('SELECT * FROM services WHERE organization_id=? AND (id=? OR slug=?)').get(org.id, body.service.id || '', body.service.slug);
        upsertService(body.organization,org,body.service);
        if (existing && body.refreshQueue === true) refreshServiceQueue(org.id, db.prepare('SELECT * FROM services WHERE id=?').get(existing.id), 'service_updated');
        return recordBySlugs(org.slug,body.service.slug);
      });
      broadcast(orgSlug,serviceSlug); return json(res,200,record);
    }
    if (req.method==='POST' && operation==='join') {
      const body=await readBody(req); const result=runTransaction(()=>{
        const record=recordBySlugs(orgSlug,serviceSlug); if(!record) return {status:404,body:{error:'Service not found'}}; const org=db.prepare('SELECT * FROM organizations WHERE slug=?').get(orgSlug); const service=db.prepare('SELECT * FROM services WHERE organization_id=? AND slug=?').get(org.id,serviceSlug); const date=body.date||todayISO(); const phone=String(body.phone||'').trim(); const customerName=String(body.customerName||'').trim(); if(!service.published) return {status:403,body:{error:'This service is not published'}}; if(service.paused) return {status:409,body:{error:'This queue is paused'}}; if(!phone||!customerName) return {status:400,body:{error:'Name and phone are required'}};
        const duplicate=db.prepare("SELECT * FROM queue_entries WHERE service_id=? AND service_date=? AND phone=? AND status IN ('waiting','called','recalled')").get(service.id,date,phone); if(duplicate) return {status:200,body:{token:dbToken(duplicate),duplicate:true,...recordBySlugs(orgSlug,serviceSlug)}};
        db.prepare(`INSERT INTO customers(id,organization_id,name,phone,created_at) VALUES(?,?,?,?,?) ON CONFLICT(organization_id,phone) DO UPDATE SET name=excluded.name`).run(uid('cus'),org.id,customerName,phone,new Date().toISOString());
        const customer=db.prepare('SELECT id FROM customers WHERE organization_id=? AND phone=?').get(org.id,phone);
        const next=db.prepare('SELECT COALESCE(MAX(number),0)+1 AS number FROM queue_entries WHERE service_id=? AND service_date=?').get(service.id,date).number; const prefix=service.prefix||service.name.slice(0,1).toUpperCase(); const queueGeneration=Number(service.queue_generation || 1); const token={id:uid('tok'),date,number:next,token:`${prefix}${String(next).padStart(3,'0')}`,customerName,phone,status:'waiting',counter:null,joinedAt:new Date().toISOString(),startedAt:null,completedAt:null,serviceMinutes:null,priorityRequested:body.priorityRequested===true,priorityApproved:false,queueGeneration}; db.prepare(`INSERT INTO queue_entries(id,service_id,service_date,number,token,customer_id,customer_name,phone,status,counter,joined_at,started_at,completed_at,service_minutes,priority_requested,priority_approved,queue_generation) VALUES(@id,@serviceId,@date,@number,@token,@customerId,@customerName,@phone,@status,@counter,@joinedAt,@startedAt,@completedAt,@serviceMinutes,@priorityRequested,@priorityApproved,@queueGeneration)`).run({id:token.id,serviceId:service.id,date,number:token.number,token:token.token,customerId:customer.id,customerName,phone,status:'waiting',counter:null,joinedAt:token.joinedAt,startedAt:null,completedAt:null,serviceMinutes:null,priorityRequested:token.priorityRequested?1:0,priorityApproved:0,queueGeneration}); notify(org.id,service.id,token.id,'joined',`Token ${token.token} joined the queue.`); history(org.id,service.id,token.id,'joined',{token:token.token}); notifyQueueSignals(org.id,service.id,date); return {status:200,body:{token,...recordBySlugs(orgSlug,serviceSlug)}};
      }); broadcast(orgSlug,serviceSlug); return json(res,result.status,result.body);
    }
    if (req.method==='POST' && operation==='action') {
      const body=await readBody(req); const result=runTransaction(()=>{
        const record=recordBySlugs(orgSlug,serviceSlug); if(!record) return {status:404,body:{error:'Service not found'}};
        const org=db.prepare('SELECT * FROM organizations WHERE slug=?').get(orgSlug);
        const service=db.prepare('SELECT * FROM services WHERE organization_id=? AND slug=?').get(org.id,serviceSlug);
        const date=body.date||todayISO();
        const settings=safeJson(service.schedule_json,{});
        const counterFor=number => (Number(number)%Math.max(1,Number(settings.counters||1)))+1;
        const waiting=()=>db.prepare("SELECT * FROM queue_entries WHERE service_id=? AND service_date=? AND status='waiting' ORDER BY priority_approved DESC, number ASC").all(service.id,date);
        const current=()=>db.prepare("SELECT * FROM queue_entries WHERE service_id=? AND service_date=? AND status IN ('called','recalled') ORDER BY started_at ASC LIMIT 1").get(service.id,date);
        const byId=id=>db.prepare('SELECT * FROM queue_entries WHERE id=? AND service_id=?').get(id,service.id);
        const finishNext=()=>{
          const next=waiting()[0];
          if (!next) return null;
          const now=new Date().toISOString();
          db.prepare("UPDATE queue_entries SET status='called', started_at=?, grace_started_at=?, counter=? WHERE id=?").run(now,now,counterFor(next.number),next.id);
          notify(org.id,service.id,next.id,'called',`Token ${next.token} is now being served.`);
          history(org.id,service.id,next.id,'called',{token:next.token,automatic:true});
          return next;
        };
        let entry=null; const action=body.action;
        if(action==='call-next') {
          if(current()) return {status:409,body:{error:'A token is already being served',...recordBySlugs(orgSlug,serviceSlug)}};
          entry=waiting()[0]; if(!entry) return {status:409,body:{error:'No waiting tokens',...recordBySlugs(orgSlug,serviceSlug)}};
          const now=new Date().toISOString();
          db.prepare("UPDATE queue_entries SET status='called', started_at=?, grace_started_at=?, counter=? WHERE id=?").run(now,now,counterFor(entry.number),entry.id);
          notify(org.id,service.id,entry.id,'called',`Token ${entry.token} is now being served.`);
          history(org.id,service.id,entry.id,'called',{token:entry.token});
        }
        if(action==='complete-token') {
          entry=current(); if(!entry) return {status:409,body:{error:'No current token',...recordBySlugs(orgSlug,serviceSlug)}};
          const completedAt=new Date().toISOString();
          const startedAt=entry.started_at || completedAt;
          const minutes=Math.max(1,Math.round((Date.now()-new Date(startedAt).getTime())/60000));
          db.prepare("UPDATE queue_entries SET status='completed', completed_at=?, service_minutes=? WHERE id=?").run(completedAt,minutes,entry.id);
          notify(org.id,service.id,entry.id,'completed',`Your service ${entry.token} has been completed.`);
          history(org.id,service.id,entry.id,'completed',{minutes});
          finishNext();
        }
        if(action==='skip-token') {
          entry=byId(body.tokenId);
          if(entry && ['waiting','called','recalled'].includes(entry.status)) {
            const wasCurrent = ['called','recalled'].includes(entry.status);
            if(wasCurrent) {
              const elapsed=Math.max(0,Date.now()-new Date(entry.grace_started_at || entry.started_at || Date.now()).getTime());
              const graceSeconds=serviceGraceSeconds(service);
              if(elapsed < graceSeconds*1000 && !body.force) return {status:409,body:{error:`Keep the token in grace period for ${Math.ceil((graceSeconds*1000-elapsed)/1000)} more seconds.`,graceRemaining:Math.ceil((graceSeconds*1000-elapsed)/1000),...recordBySlugs(orgSlug,serviceSlug)}};
              db.prepare("UPDATE queue_entries SET status='no-show', completed_at=? WHERE id=?").run(new Date().toISOString(),entry.id);
              notify(org.id,service.id,entry.id,'no-show',`Token ${entry.token} was marked no-show after the ${Math.round(graceSeconds/60)}-minute grace period.`);
              history(org.id,service.id,entry.id,'no-show',{token:entry.token,graceSeconds});
            } else {
              db.prepare("UPDATE queue_entries SET status='skipped', completed_at=? WHERE id=?").run(new Date().toISOString(),entry.id);
              notify(org.id,service.id,entry.id,'skipped',`Token ${entry.token} was skipped.`);
              history(org.id,service.id,entry.id,'skipped',{token:entry.token});
            }
            if (wasCurrent) finishNext();
          }
        }
        if(action==='cancel-token') {
          entry=byId(body.tokenId);
          if(entry && ['waiting','called','recalled'].includes(entry.status)) {
            const wasCurrent=['called','recalled'].includes(entry.status);
            db.prepare("UPDATE queue_entries SET status='cancelled', completed_at=? WHERE id=?").run(new Date().toISOString(),entry.id);
            notify(org.id,service.id,entry.id,'cancelled',`Token ${entry.token} was cancelled.`);
            history(org.id,service.id,entry.id,'cancelled',{token:entry.token});
            if(wasCurrent) finishNext();
          }
        }
        if(action==='no-show-token') {
          entry=byId(body.tokenId) || current();
          if(!entry) return {status:409,body:{error:'No token is ready to mark no-show',...recordBySlugs(orgSlug,serviceSlug)}};
          const elapsed=Math.max(0,Date.now()-new Date(entry.grace_started_at || entry.started_at || Date.now()).getTime());
          const graceSeconds=serviceGraceSeconds(service);
          if(elapsed < graceSeconds*1000 && !body.force) return {status:409,body:{error:`Grace period ends in ${Math.ceil((graceSeconds*1000-elapsed)/1000)} seconds.`,graceRemaining:Math.ceil((graceSeconds*1000-elapsed)/1000),...recordBySlugs(orgSlug,serviceSlug)}};
          db.prepare("UPDATE queue_entries SET status='no-show', completed_at=? WHERE id=?").run(new Date().toISOString(),entry.id);
          notify(org.id,service.id,entry.id,'no-show',`Token ${entry.token} was marked no-show after the ${Math.round(graceSeconds/60)}-minute grace period.`);
          history(org.id,service.id,entry.id,'no-show',{token:entry.token,graceSeconds});
          finishNext();
        }
        if(action==='recall-token') {
          entry=byId(body.tokenId) || current();
          if(entry && ['skipped','no-show'].includes(entry.status)) {
            if(current()) return {status:409,body:{error:'Complete the current token before recalling another.',...recordBySlugs(orgSlug,serviceSlug)}};
            const now=new Date().toISOString();
            db.prepare("UPDATE queue_entries SET status='recalled', started_at=?, grace_started_at=?, completed_at=NULL, counter=?, last_recalled_at=? WHERE id=?").run(now,now,counterFor(entry.number),now,entry.id);
            notify(org.id,service.id,entry.id,'recalled',`Token ${entry.token} was recalled to Counter ${counterFor(entry.number)}.`);
            history(org.id,service.id,entry.id,'recalled',{token:entry.token,fromStatus:entry.status});
          } else if(entry && ['called','recalled'].includes(entry.status)) {
            const now=new Date().toISOString();
            db.prepare('UPDATE queue_entries SET last_recalled_at=? WHERE id=?').run(now,entry.id);
            notify(org.id,service.id,entry.id,'recalled',`Token ${entry.token} was recalled.`);
            history(org.id,service.id,entry.id,'recalled',{token:entry.token});
          }
        }
        if(action==='toggle-pause') { const paused=!Boolean(service.paused); db.prepare('UPDATE services SET paused=? WHERE id=?').run(paused?1:0,service.id); history(org.id,service.id,null,paused?'paused':'resumed',{}); }
        if(action==='verify-priority') { entry=byId(body.tokenId); if(entry) { db.prepare('UPDATE queue_entries SET priority_approved=1 WHERE id=?').run(entry.id); history(org.id,service.id,entry.id,'priority_verified',{token:entry.token}); } }
        notifyQueueSignals(org.id,service.id,date);
        return {status:200,body:recordBySlugs(orgSlug,serviceSlug)};
      });
      broadcast(orgSlug,serviceSlug); return json(res,result.status,result.body);
    }

    return json(res,405,{error:'Method not allowed'});
  } catch(error) { console.error(error); return json(res,500,{error:'Database error'}); }
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.md':'text/markdown; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{ const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); if(url.pathname.startsWith('/api/')) return handleApi(req,res,url); if(req.method!=='GET'&&req.method!=='HEAD') return text(res,405,'Method not allowed'); let requestPath=decodeURIComponent(url.pathname); if(requestPath==='/') requestPath='/index.html'; const file=path.normalize(path.join(ROOT,requestPath)); if(!file.startsWith(ROOT)) return text(res,403,'Forbidden'); fs.readFile(file,(error,data)=>{ if(error) return text(res,404,'Not found'); let output=data; if(path.basename(file)==='index.html' && (process.env.PUBLIC_BASE_URL || process.env.API_BASE_URL)) { let html=data.toString(); if(process.env.PUBLIC_BASE_URL) { const escaped=String(process.env.PUBLIC_BASE_URL).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); html=html.replace('<meta name="queueflow-public-origin" content="" />', `<meta name="queueflow-public-origin" content="${escaped}" />`); } if(process.env.API_BASE_URL) { const escaped=String(process.env.API_BASE_URL).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); html=html.replace('<meta name="queueflow-api-base" content="" />', `<meta name="queueflow-api-base" content="${escaped}" />`); } output=Buffer.from(html); } res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}); if(req.method==='HEAD') return res.end(); res.end(output); }); });
const wss=new WebSocketServer({ noServer:true });
server.on('upgrade',(req,socket,head)=>{ const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); const match=url.pathname.match(/^\/ws\/services\/([^/]+)\/([^/]+)$/); if(!match) return socket.destroy(); const orgSlug=decodeURIComponent(match[1]); const serviceSlug=decodeURIComponent(match[2]); wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,orgSlug,serviceSlug)); });
wss.on('connection',(ws,orgSlug,serviceSlug)=>{ const key=roomKey(orgSlug,serviceSlug); if(!clients.has(key)) clients.set(key,new Set()); clients.get(key).add(ws); const record=recordBySlugs(orgSlug,serviceSlug); if(record) ws.send(JSON.stringify({type:'queue.updated',...record})); ws.on('close',()=>{ clients.get(key)?.delete(ws); if(!clients.get(key)?.size) clients.delete(key); }); });
server.listen(PORT,'0.0.0.0',()=>console.log(`QueueHub SQLite/WebSocket server running on 0.0.0.0:${PORT}`));
