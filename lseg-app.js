// ╔════════════════════════════════════════════════════════════════╗
// ║  CONFIGURATION — UPDATE THESE THREE VALUES                   ║
// ╚════════════════════════════════════════════════════════════════╝
const SUPABASE_URL = 'https://hsnzhluqydtlxsrymvdr.supabase.co';       // e.g. https://xxxx.supabase.co
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzbnpobHVxeWR0bHhzcnltdmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1Njg0MTksImV4cCI6MjA4NzE0NDQxOX0.RTMCoRSd2FzhmljSOtsltLJubeXn7zFmoBSx4F6GKlI';  // Legacy anon key (starts with eyJ...)
const N8N_ASSIGN_URL = 'https://promptoran8n.promptora.in/webhook-test/ai-assign';                        // e.g. http://localhost:5678/webhook/ai-assign
const N8N_CHAT_URL   = 'https://promptoran8n.promptora.in/webhook-test/ai-chatbot';                        // e.g. http://localhost:5678/webhook/chat
const N8N_BATCH_URL  = '';                        // e.g. http://localhost:5678/webhook/batch-assign
const N8N_EMBED_URL  = '';                        // e.g. http://localhost:5678/webhook/embed-task

// ── Supabase client ─────────────────────────────────────────────
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Global state ────────────────────────────────────────────────
var ANALYSTS = [];
var TASKS = [];
var LEAVES = [];
var QUEUES_MAP = {};
var DOMAINS_MAP = {};
var QUEUES_LIST = [];
var DOMAINS_LIST = [];
var CFG = { autoAssign: false, showNotif: true, ingestAuto: false, useN8n: false, scoringWeights: null, notRecThreshold: 50 };

var currentPage = 'tasks';
var currentQueueFilter = null;
var currentStatusFilter = 'all';
var chatOpen = false;
var activePopover = null;
var _aiTaskId = null;
var _aiSugs = [];
var _lastScoringEngine = 'local';
var _lastAllScored = [];
var foRows = [];
var foCounter = 0;

// ── Avatar helpers ──────────────────────────────────────────────
const AVATAR_COLORS = ['#0078d4','#c239b3','#107c10','#ca5010','#5c2d91','#038387','#8b0000','#004e8c','#7b4f3a','#486860'];
function getInitials(name) {
  if (!name) return '??';
  return name.split(' ').map(function(w){ return w[0]; }).join('').toUpperCase().slice(0, 2);
}
function getColor(id) {
  var hash = 0;
  for (var i = 0; i < (id||'').length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ── Data loading ────────────────────────────────────────────────
async function loadQueuesAndDomains() {
  var qRes = await sb.from('queues').select('*').eq('active', true);
  var dRes = await sb.from('domains').select('*').eq('active', true);
  QUEUES_LIST = qRes.data || [];
  DOMAINS_LIST = dRes.data || [];
  QUEUES_MAP = {};
  DOMAINS_MAP = {};
  QUEUES_LIST.forEach(function(q){ QUEUES_MAP[q.id] = q.name; });
  DOMAINS_LIST.forEach(function(d){ DOMAINS_MAP[d.id] = d.name; });
}

async function loadAnalysts() {
  var res = await sb.from('analysts').select('*');
  if (res.error) console.error('Load analysts:', res.error);
  ANALYSTS = (res.data || []).map(function(a){
    return Object.assign({}, a, {
      name: a.full_name,
      initials: getInitials(a.full_name),
      color: getColor(a.id),
      queues: (a.queue_ids || []).map(function(qid){ return QUEUES_MAP[qid] || qid; }),
      queue_ids_raw: a.queue_ids || [],
      domains: (a.domain_ids || []).map(function(did){ return DOMAINS_MAP[did] || did; }),
      domain_ids_raw: a.domain_ids || [],
      skills: a.speciality || [],
      active: a.active_tasks || 0,
      exp: a.experience_yrs || 0,
      country: a.country || '',
      tz: a.timezone || '',
      wh_from: a.working_hrs_from || null,
      wh_to: a.working_hrs_to || null,
      temp_unavail: a.temp_unavailable_until ? new Date(a.temp_unavailable_until) : null
    });
  });
}

async function loadLeaves() {
  var today = new Date().toISOString().split('T')[0];
  var res = await sb.from('analyst_leaves').select('*').gte('date_to', today);
  LEAVES = res.data || [];
}

async function loadTasks() {
  // Production: load only active + recent tasks (not all 1000s of resolved)
  var res = await sb.from('tasks').select('*')
    .or('status.in.(New,Active,Blocked),created_at.gte.' + new Date(Date.now() - 7*86400000).toISOString())
    .order('created_at', { ascending: false })
    .limit(500);
  if (res.error) console.error('Load tasks:', res.error);
  TASKS = (res.data || []).map(mapTask);
}

function mapTask(t) {
  var slaDate = t.sla_deadline ? new Date(t.sla_deadline) : new Date(Date.now() + 24*3600000);
  return Object.assign({}, t, {
    desc: t.description || '',
    queue: QUEUES_MAP[t.queue_id] || t.queue_id || '',
    queue_id_raw: t.queue_id,
    domain: DOMAINS_MAP[t.domain_id] || t.domain_id || '',
    domain_id_raw: t.domain_id,
    assignee: t.assignee_id,
    assignedBy: t.assigned_by,
    sla: slaDate,
    due: new Date(slaDate.getTime() + 4 * 3600000),
    created: t.created_at ? new Date(t.created_at) : new Date(),
    outcomes: t.outcomes_count || 0,
    open: t.open_count || 0,
    aiScore: null
  });
}

async function loadConfig() {
  try {
    var res = await sb.from('config').select('*');
    if (res.data) {
      res.data.forEach(function(row){
        if (row.key === 'auto_assign') CFG.autoAssign = !!(row.value && row.value.enabled);
        if (row.key === 'show_notif') CFG.showNotif = !(row.value && row.value.enabled === false);
        if (row.key === 'ingest_auto') CFG.ingestAuto = !!(row.value && row.value.enabled);
        if (row.key === 'use_n8n') CFG.useN8n = !!(row.value && row.value.enabled);
        if (row.key === 'scoring_weights' && row.value) CFG.scoringWeights = row.value;
        if (row.key === 'not_rec_threshold' && row.value) CFG.notRecThreshold = row.value.threshold || 50;
      });
    }
  } catch(e) { console.warn('Config load fallback:', e); }
}

// ── Availability helpers ────────────────────────────────────────
function isTempUnavailable(analystId) {
  var a = getAnalyst(analystId);
  if (!a || !a.temp_unavail) return false;
  return a.temp_unavail > new Date();
}
function getTempUnavailNote(analystId) {
  var a = getAnalyst(analystId);
  if (!a || !a.temp_unavail || a.temp_unavail <= new Date()) return null;
  var diff = a.temp_unavail - new Date();
  var hrs = Math.floor(diff / 3600000);
  var mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return 'Back in ~' + hrs + 'h ' + mins + 'm';
  return 'Back in ~' + mins + 'm';
}
function isOnLeaveToday(analystId) {
  var today = new Date().toISOString().split('T')[0];
  return LEAVES.some(function(l){
    return l.analyst_id === analystId && l.approved !== false && l.date_from <= today && l.date_to >= today;
  });
}
function isUnavailable(analystId) {
  return isOnLeaveToday(analystId) || isTempUnavailable(analystId);
}
function getLeaveNote(analystId) {
  var tempNote = getTempUnavailNote(analystId);
  if (tempNote) return 'Temp Away — ' + tempNote;
  var today = new Date().toISOString().split('T')[0];
  var leave = LEAVES.find(function(l){
    return l.analyst_id === analystId && l.approved !== false && l.date_from <= today && l.date_to >= today;
  });
  return leave ? (leave.type || 'On Leave') : null;
}
function getNext5DaysAvail(analystId) {
  var days = [];
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  for (var i = 0; i < 5; i++) {
    var d = new Date(); d.setDate(d.getDate() + i);
    var ds = d.toISOString().split('T')[0];
    var onLeave = LEAVES.some(function(l){
      return l.analyst_id === analystId && l.approved !== false && l.date_from <= ds && l.date_to >= ds;
    });
    days.push({ label: i === 0 ? 'Today' : dayNames[d.getDay()], available: !onLeave });
  }
  return days;
}
function getUpcomingLeaves(analystId) {
  var today = new Date().toISOString().split('T')[0];
  var upcoming = LEAVES.filter(function(l){
    return l.analyst_id === analystId && l.approved !== false && l.date_to >= today;
  });
  return upcoming.sort(function(a,b){ return a.date_from < b.date_from ? -1 : 1; }).slice(0, 3);
}
function isInWorkingHours(analyst) {
  if (!analyst.wh_from || !analyst.wh_to) return { inHours: true, label: 'Not Set' };
  try {
    var now = new Date();
    var opts = analyst.tz ? { timeZone: analyst.tz, hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false };
    var localTime = now.toLocaleTimeString('en-GB', opts);
    var fromStr = String(analyst.wh_from).slice(0, 5);
    var toStr = String(analyst.wh_to).slice(0, 5);
    var inHours = localTime >= fromStr && localTime <= toStr;
    return { inHours: inHours, label: fromStr + ' - ' + toStr, localTime: localTime };
  } catch(e) {
    return { inHours: true, label: 'N/A' };
  }
}
function formatTZ(tz) {
  if (!tz) return '';
  var parts = tz.split('/');
  return parts.length > 1 ? parts[1].replace(/_/g, ' ') : tz;
}

// ── Populate dropdowns & nav ────────────────────────────────────
function populateDropdowns() {
  var qOpts = QUEUES_LIST.map(function(q){ return '<option value="'+q.id+'">'+q.name+'</option>'; }).join('');
  var dOpts = DOMAINS_LIST.map(function(d){ return '<option value="'+d.id+'">'+d.name+'</option>'; }).join('');
  document.querySelectorAll('.queue-dropdown').forEach(function(el){ el.innerHTML = qOpts; });
  document.querySelectorAll('.domain-dropdown').forEach(function(el){ el.innerHTML = dOpts; });
  var navHtml = QUEUES_LIST.map(function(q){
    var cnt = TASKS.filter(function(t){ return t.queue_id === q.id && t.status !== 'Resolved' && t.status !== 'Closed'; }).length;
    return '<div class="nav-item" id="nav-q-'+q.id+'" onclick="filterQueue(\''+q.id+'\',\''+q.name+'\')"><span class="nav-icon">&#8920;</span> '+q.name+'<span class="nav-count">'+cnt+'</span></div>';
  }).join('');
  document.getElementById('queue-nav-items').innerHTML = navHtml;
}
function updateBadges() {
  var open = TASKS.filter(function(t){ return t.status !== 'Resolved' && t.status !== 'Closed'; }).length;
  var sla = TASKS.filter(function(t){ return t.status !== 'Resolved' && t.status !== 'Closed' && getSLA(t).cls !== 'sla-ok'; }).length;
  document.getElementById('badge-open').textContent = open;
  document.getElementById('badge-sla').textContent = sla;
}

// ── Realtime subscriptions ──────────────────────────────────────
function setupRealtime() {
  sb.channel('tasks-rt').on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, function(payload){
    if (payload.eventType === 'INSERT') {
      if (!TASKS.find(function(t){ return t.id === payload.new.id; })) {
        TASKS.unshift(mapTask(payload.new));
        notify('New Task', (payload.new.ref || 'Task') + ' appeared.', 'info');
      }
    } else if (payload.eventType === 'UPDATE') {
      var idx = TASKS.findIndex(function(t){ return t.id === payload.new.id; });
      if (idx > -1) TASKS[idx] = mapTask(payload.new); else TASKS.unshift(mapTask(payload.new));
    } else if (payload.eventType === 'DELETE') {
      TASKS = TASKS.filter(function(t){ return t.id !== payload.old.id; });
    }
    refreshCurrentPage();
  }).subscribe();

  sb.channel('analysts-rt').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'analysts' }, function(payload){
    var idx = ANALYSTS.findIndex(function(a){ return a.id === payload.new.id; });
    if (idx > -1) {
      var a = payload.new;
      ANALYSTS[idx] = Object.assign({}, ANALYSTS[idx], a, {
        name: a.full_name, active: a.active_tasks || 0,
        queues: (a.queue_ids || []).map(function(qid){ return QUEUES_MAP[qid] || qid; }),
        queue_ids_raw: a.queue_ids || [],
        domains: (a.domain_ids || []).map(function(did){ return DOMAINS_MAP[did] || did; }),
        domain_ids_raw: a.domain_ids || [],
        skills: a.speciality || [],
        wh_from: a.working_hrs_from || null, wh_to: a.working_hrs_to || null, tz: a.timezone || '',
        temp_unavail: a.temp_unavailable_until ? new Date(a.temp_unavailable_until) : null
      });
    }
    if (currentPage === 'team') renderTeam();
  }).subscribe();

  sb.channel('leaves-rt').on('postgres_changes', { event: '*', schema: 'public', table: 'analyst_leaves' }, function(){
    loadLeaves().then(function(){ if (currentPage === 'team') renderTeam(); });
  }).subscribe();
}

function refreshCurrentPage() {
  if (currentPage === 'tasks') renderTasks();
  else if (currentPage === 'sla') renderSLA();
  updateBadges();
  populateDropdowns();
}

// ── Common utils ────────────────────────────────────────────────
function getAnalyst(id) { return ANALYSTS.find(function(a){ return a.id === id; }); }
function getSLA(t) {
  var ms = t.sla - new Date();
  var hrs = ms / 3600000;
  if (hrs < 0) return { cls:'sla-breached', label:'BREACHED', txt:Math.abs(Math.round(hrs))+'h overdue', dot:'pulse' };
  if (hrs < 2) return { cls:'sla-risk', label:'AT RISK', txt:Math.round(hrs*60)+'m left', dot:'pulse' };
  return { cls:'sla-ok', label:'ON TRACK', txt:Math.round(hrs)+'h left', dot:'' };
}
function fmtTime(d) {
  if (!d) return '';
  var diff = new Date() - d;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return Math.round(diff/60000)+'m ago';
  if (diff < 86400000) return Math.round(diff/3600000)+'h ago';
  return d.toLocaleDateString();
}
function pClass(p) { return 'b-'+(p||'medium').toLowerCase(); }
function sClass(s) { return 'b-'+(s||'new').toLowerCase(); }
function priColor(p) { return {Critical:'#d13438',High:'#ca5010',Medium:'#0078d4',Low:'#107c10'}[p]||'#666'; }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }
function notify(title, msg, type) {
  type = type || 'info';
  var icons = {success:'&#10003;',error:'&#10007;',info:'&#8505;',warn:'&#9888;'};
  var el = document.createElement('div');
  el.className = 'notif '+type;
  el.innerHTML = '<div class="notif-icon">'+icons[type]+'</div><div class="notif-body"><div class="notif-title">'+title+'</div><div class="notif-msg">'+msg+'</div></div>';
  document.getElementById('notif-area').appendChild(el);
  setTimeout(function(){ el.style.transition='opacity 0.4s'; el.style.opacity='0'; setTimeout(function(){ el.remove(); },400); },4500);
}
document.addEventListener('click', function(e){
  if (activePopover && !activePopover.contains(e.target)) {
    var pop = activePopover.querySelector('.ai-popover');
    if (pop) pop.classList.remove('show');
    activePopover = null;
  }
});

// ── Navigation ──────────────────────────────────────────────────
function setNav(id) {
  document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); });
  var el = document.getElementById(id);
  if (el) el.classList.add('active');
}
function _closeMobileSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  var bd = document.getElementById('sidebar-backdrop');
  if (bd) bd.classList.remove('open');
}
function showPage(p) {
  _closeMobileSidebar();
  currentPage = p; currentQueueFilter = null; currentStatusFilter = 'all';
  setNav('nav-'+p);
  var titles = {tasks:'Task Queue',sla:'SLA Monitor',team:'Team'};
  var bcs = {tasks:'All Queues \u00b7 All Status',sla:'Real-time SLA tracking',team:'Analyst workload & availability'};
  document.getElementById('page-title').textContent = titles[p];
  document.getElementById('page-bc').textContent = bcs[p];
  if (p === 'tasks') renderTasks();
  else if (p === 'sla') renderSLA();
  else if (p === 'team') renderTeam();
}
function filterQueue(qid, qname) {
  _closeMobileSidebar();
  currentPage = 'tasks'; currentQueueFilter = qid; currentStatusFilter = 'all';
  document.querySelectorAll('.nav-item').forEach(function(n){ n.classList.remove('active'); });
  var el = document.getElementById('nav-q-'+qid);
  if (el) el.classList.add('active');
  document.getElementById('page-title').textContent = (qname||qid)+' Queue';
  document.getElementById('page-bc').textContent = 'Queue \u00b7 All Status';
  renderTasks();
}

// ── Config ──────────────────────────────────────────────────────
function openConfigModal() {
  document.getElementById('cfg-auto').checked = CFG.autoAssign;
  document.getElementById('cfg-notif').checked = CFG.showNotif;
  document.getElementById('cfg-ingest-auto').checked = CFG.ingestAuto;
  document.getElementById('cfg-use-n8n').checked = CFG.useN8n;
  var n8nStatus = document.getElementById('cfg-n8n-status');
  if (n8nStatus) {
    var assignOk = N8N_ASSIGN_URL && N8N_ASSIGN_URL.length > 5;
    var chatOk = N8N_CHAT_URL && N8N_CHAT_URL.length > 5;
    n8nStatus.innerHTML = (assignOk ? '&#9679; Assign URL configured' : '&#9675; Assign URL not set') + '<br>' + (chatOk ? '&#9679; Chat URL configured' : '&#9675; Chat URL not set');
    n8nStatus.style.color = (assignOk && chatOk) ? 'var(--green)' : 'var(--text4)';
  }
  // Populate scoring weight sliders
  var W = getWeights();
  var dims = SCORING_DIMS || ['Availability','Workload','Speciality','Working Hours','Resolution History','SLA Fit'];
  var wSum = 0;
  dims.forEach(function(d){ wSum += (W[d] || 0); });
  dims.forEach(function(d){
    var el = document.getElementById('cfg-w-' + d.replace(/\s/g, '-'));
    var lbl = document.getElementById('cfg-wl-' + d.replace(/\s/g, '-'));
    if (el) el.value = W[d] || 0;
    var eff = wSum > 0 ? Math.round((W[d] || 0) / wSum * 1000) / 10 : 0;
    if (lbl) lbl.innerHTML = (W[d] || 0) + ' <span style="color:var(--text4);font-weight:400;font-size:10px;">(' + eff + '%)</span>';
  });
  var totalEl = document.getElementById('cfg-w-total');
  if (totalEl) totalEl.textContent = 'Total: ' + wSum + ' (weights are relative — effective % shown)';
  var nrt = document.getElementById('cfg-not-rec-threshold');
  var nrtLbl = document.getElementById('cfg-wl-not-rec');
  if (nrt) nrt.value = CFG.notRecThreshold || 50;
  if (nrtLbl) nrtLbl.textContent = (CFG.notRecThreshold || 50) + '%';
  openModal('config-overlay');
}
async function updateConfig() {
  CFG.autoAssign = document.getElementById('cfg-auto').checked;
  CFG.showNotif = document.getElementById('cfg-notif').checked;
  CFG.ingestAuto = document.getElementById('cfg-ingest-auto').checked;
  CFG.useN8n = document.getElementById('cfg-use-n8n').checked;
  try {
    await sb.from('config').upsert({key:'auto_assign',value:{enabled:CFG.autoAssign},updated_at:new Date().toISOString()});
    await sb.from('config').upsert({key:'show_notif',value:{enabled:CFG.showNotif},updated_at:new Date().toISOString()});
    await sb.from('config').upsert({key:'ingest_auto',value:{enabled:CFG.ingestAuto},updated_at:new Date().toISOString()});
    await sb.from('config').upsert({key:'use_n8n',value:{enabled:CFG.useN8n},updated_at:new Date().toISOString()});
  } catch(e){ console.warn('Config save error:', e); }
}
async function updateWeights() {
  var dims = SCORING_DIMS || ['Availability','Workload','Speciality','Working Hours','Resolution History','SLA Fit'];
  var w = {};
  var wSum = 0;
  dims.forEach(function(d){
    var el = document.getElementById('cfg-w-' + d.replace(/\s/g, '-'));
    w[d] = el ? parseInt(el.value) || 0 : 20;
    wSum += w[d];
  });
  // Show effective percentage for each dimension
  dims.forEach(function(d){
    var lbl = document.getElementById('cfg-wl-' + d.replace(/\s/g, '-'));
    var eff = wSum > 0 ? Math.round(w[d] / wSum * 1000) / 10 : 0;
    if (lbl) lbl.innerHTML = w[d] + ' <span style="color:var(--text4);font-weight:400;font-size:10px;">(' + eff + '%)</span>';
  });
  // Show total
  var totalEl = document.getElementById('cfg-w-total');
  if (totalEl) totalEl.textContent = 'Total: ' + wSum + ' (weights are relative — effective % shown)';
  CFG.scoringWeights = w;
  var nrt = document.getElementById('cfg-not-rec-threshold');
  var nrtLbl = document.getElementById('cfg-wl-not-rec');
  if (nrt) { CFG.notRecThreshold = parseInt(nrt.value) || 50; }
  if (nrtLbl) nrtLbl.textContent = CFG.notRecThreshold + '%';
  try {
    await sb.from('config').upsert({key:'scoring_weights', value: w, updated_at:new Date().toISOString()});
    await sb.from('config').upsert({key:'not_rec_threshold', value: {threshold: CFG.notRecThreshold}, updated_at:new Date().toISOString()});
  } catch(e){ console.warn('Weights save error:', e); }
}

// ── Render: Task Queue ──────────────────────────────────────────
function renderTasks() {
  var filtered = TASKS.filter(function(t){
    if (currentQueueFilter && t.queue_id !== currentQueueFilter) return false;
    if (currentStatusFilter === 'unassigned') return !t.assignee;
    if (currentStatusFilter !== 'all' && t.status !== currentStatusFilter) return false;
    return true;
  });
  var total = TASKS.length;
  var active = TASKS.filter(function(t){ return t.status==='Active'; }).length;
  var breached = TASKS.filter(function(t){ return getSLA(t).cls==='sla-breached'&&t.status!=='Resolved'&&t.status!=='Closed'; }).length;
  var atRisk = TASKS.filter(function(t){ return getSLA(t).cls==='sla-risk'&&t.status!=='Resolved'&&t.status!=='Closed'; }).length;
  var resolved = TASKS.filter(function(t){ return t.status==='Resolved'; }).length;

  var html = '<div class="stats-row">'
    +'<div class="stat-card c-total"><div class="stat-label">Total Tasks</div><div class="stat-value">'+total+'</div><div class="stat-sub">All queues</div></div>'
    +'<div class="stat-card c-active"><div class="stat-label">Active</div><div class="stat-value">'+active+'</div><div class="stat-sub">In progress</div></div>'
    +'<div class="stat-card c-breach"><div class="stat-label">SLA Breached</div><div class="stat-value">'+breached+'</div><div class="stat-sub">Immediate action</div></div>'
    +'<div class="stat-card c-risk"><div class="stat-label">SLA At Risk</div><div class="stat-value">'+atRisk+'</div><div class="stat-sub">Within 2 hours</div></div>'
    +'<div class="stat-card c-resolved"><div class="stat-label">Resolved</div><div class="stat-value">'+resolved+'</div><div class="stat-sub">Completed</div></div></div>';

  html += '<div class="config-bar"><span class="config-bar-label">&#9889; AI Auto-Assign:</span>'
    +'<label class="toggle"><input type="checkbox"'+(CFG.autoAssign?' checked':'')+' onchange="CFG.autoAssign=this.checked;updateConfig();notify(\'Settings\',this.checked?\'Auto-assign ON\':\'Auto-assign OFF\',\'info\');"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>'
    +'<span class="config-bar-label" style="margin-left:16px;">Notifications:</span>'
    +'<label class="toggle"><input type="checkbox"'+(CFG.showNotif?' checked':'')+' onchange="CFG.showNotif=this.checked;updateConfig();"><div class="toggle-track"></div><div class="toggle-thumb"></div></label>'
    +'<span class="config-info"><span style="color:var(--blue);cursor:pointer;font-weight:600;" onclick="openConfigModal()">AI Settings &#8250;</span></span></div>';

  html += '<div class="command-bar">'
    +'<button class="btn btn-default btn-sm" onclick="setStatusFilter(\'all\',this)">All</button>'
    +'<button class="btn btn-default btn-sm" onclick="setStatusFilter(\'New\',this)">New</button>'
    +'<button class="btn btn-default btn-sm" onclick="setStatusFilter(\'Active\',this)">Active</button>'
    +'<button class="btn btn-default btn-sm" onclick="setStatusFilter(\'Blocked\',this)">Blocked</button>'
    +'<button class="btn btn-default btn-sm" onclick="setStatusFilter(\'Resolved\',this)">Resolved</button>'
    +'<button class="btn btn-default btn-sm" onclick="setStatusFilter(\'unassigned\',this)">Unassigned</button>'
    +'<div class="cmd-divider"></div>'
    +'<div class="search-wrap"><span class="search-icon">&#128269;</span><input class="search-box" placeholder="Search tasks..." oninput="liveSearch(this.value)"/></div></div>';

  html += '<div class="table-card"><table><thead><tr><th>Task Ref</th><th>Description</th><th>Queue</th><th>Priority</th><th>Status</th><th>Domain</th><th>Assignee</th><th>SLA Status</th><th>Open / Total</th><th>Actions</th></tr></thead><tbody id="task-tbody">';
  if (!filtered.length) {
    html += '<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">&#9711;</div><div class="empty-text">No tasks match the current filter</div></div></td></tr>';
  } else {
    filtered.forEach(function(t){ html += renderTaskRow(t); });
  }
  html += '</tbody></table></div>';
  document.getElementById('main-content').innerHTML = html;
  updateBadges();
}

function renderTaskRow(t) {
  var sla = getSLA(t);
  var analyst = t.assignee ? getAnalyst(t.assignee) : null;
  var hasAI = t.assignedBy === 'AI_AUTO' || t.assignedBy === 'AI_SUGGESTED';
  var assigneeHTML;
  if (analyst) {
    var aiBadge = (hasAI && t.ai_confidence) ? '<span class="ai-badge-btn" onclick="event.stopPropagation();openAISuggest(\''+t.id+'\')">&#9889; '+t.ai_confidence+'%</span>' : '';
    assigneeHTML = '<div class="assignee-wrap"><div class="av-chip" style="background:'+analyst.color+'">'+analyst.initials+'</div><span style="font-size:13px;">'+analyst.name.split(' ')[0]+'</span>'+aiBadge+'</div>';
  } else {
    assigneeHTML = '<span class="unassigned-tag">Unassigned</span>';
  }
  var actionsHTML = !t.assignee
    ? '<button class="btn btn-ai btn-xs" onclick="event.stopPropagation();openAISuggest(\''+t.id+'\')">&#9889; AI Assign</button>'
    : '<button class="btn btn-default btn-xs" onclick="event.stopPropagation();openAISuggest(\''+t.id+'\')">Reassign</button>';

  return '<tr onclick="openTask(\''+t.id+'\')">'
    +'<td><span class="task-ref-link mono">'+t.ref+'</span></td>'
    +'<td><div class="task-desc-main">'+t.desc+'</div><div class="task-desc-sub">'+t.queue+' &bull; '+fmtTime(t.created)+'</div></td>'
    +'<td><span style="font-size:12px;color:var(--text2)">'+t.queue+'</span></td>'
    +'<td><span class="badge '+pClass(t.priority)+'">'+t.priority+'</span></td>'
    +'<td><span class="badge '+sClass(t.status)+'">'+t.status+'</span></td>'
    +'<td><span style="font-size:12px;color:var(--text2)">'+t.domain+'</span></td>'
    +'<td>'+assigneeHTML+'</td>'
    +'<td><div class="sla-pill '+sla.cls+'"><div class="sla-dot '+sla.dot+'"></div>'+sla.txt+'</div></td>'
    +'<td><span class="mono" style="font-size:12px;color:'+(t.open>0?'var(--amber)':'var(--green)')+'">'+t.open+' / '+t.outcomes+'</span></td>'
    +'<td onclick="event.stopPropagation()">'+actionsHTML+'</td></tr>';
}

function setStatusFilter(val, btn) {
  currentStatusFilter = val;
  document.querySelectorAll('.command-bar .btn').forEach(function(b){ b.classList.remove('btn-primary'); b.classList.add('btn-default'); });
  btn.classList.remove('btn-default'); btn.classList.add('btn-primary');
  renderTasks();
}
function liveSearch(q) {
  document.querySelectorAll('#task-tbody tr').forEach(function(r){ r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none'; });
}

// ── Task Detail Modal ───────────────────────────────────────────
async function openTask(id) {
  var t = TASKS.find(function(x){ return x.id===id; });
  if (!t) return;
  var sla = getSLA(t);
  var analyst = t.assignee ? getAnalyst(t.assignee) : null;

  // Fetch real failed outcomes
  var foRes = await sb.from('failed_outcomes').select('*').eq('task_id', id);
  if (foRes.error) console.error('FO fetch error:', foRes.error);
  var outcomesData = foRes.data || [];
  console.log('Task', id, '- Failed outcomes found:', outcomesData.length, foRes.error ? 'Error:'+foRes.error.message : '');

  // Fetch AI score if AI-assigned
  var aiInfo = null;
  if (t.assignedBy === 'AI_AUTO' || t.assignedBy === 'AI_SUGGESTED') {
    var scRes = await sb.from('ai_assignment_scores').select('*').eq('task_id', id).eq('selected', true).limit(1);
    if (scRes.data && scRes.data[0]) {
      var sc = scRes.data[0];
      aiInfo = { aid:sc.analyst_id, score:sc.overall_score, reasoning:sc.reasoning, scores:sc.scores||{}, strengths:sc.strengths||[], risks:sc.risks||[], eta:sc.est_resolution_min||60 };
    }
  }

  var methodLabel = t.assignedBy==='AI_AUTO'?'AI Auto-Assigned':t.assignedBy==='AI_SUGGESTED'?'AI Suggested':'Manual';

  var html = '<div class="modal-header"><div>'
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span class="task-ref-link mono" style="font-size:13px;">'+t.ref+'</span><span class="badge '+pClass(t.priority)+'">'+t.priority+'</span><span class="badge '+sClass(t.status)+'">'+t.status+'</span><div class="sla-pill '+sla.cls+'"><div class="sla-dot '+sla.dot+'"></div>'+sla.label+' &bull; '+sla.txt+'</div></div>'
    +'<div class="modal-title">'+t.desc+'</div></div>'
    +'<div class="modal-close" onclick="closeModal(\'task-overlay\')">&#10005;</div></div>'
    +'<div class="modal-body"><div class="meta-grid">'
    +'<div class="meta-item"><div class="meta-key">Queue</div><div class="meta-val">'+t.queue+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">Domain</div><div class="meta-val">'+t.domain+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">Created</div><div class="meta-val">'+fmtTime(t.created)+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">SLA Deadline</div><div class="meta-val">'+t.sla.toLocaleString([],{dateStyle:'short',timeStyle:'short'})+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">Assignee</div><div class="meta-val">'+(analyst?analyst.name:'Unassigned')+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">Assigned By</div><div class="meta-val" style="color:'+(t.assignedBy==='AI_AUTO'||t.assignedBy==='AI_SUGGESTED'?'var(--teal)':'var(--text)')+'">'+(t.assignedBy?methodLabel:'&mdash;')+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">Field</div><div class="meta-val">'+(t.field||'&mdash;')+'</div></div>'
    +'<div class="meta-item"><div class="meta-key">Open Outcomes</div><div class="meta-val" style="color:var(--amber)">'+t.open+' / '+t.outcomes+'</div></div></div>';

  // AI insight panel
  if (aiInfo) {
    var scoreKeys = Object.keys(aiInfo.scores);
    var barsHTML = scoreKeys.map(function(k){
      var v = aiInfo.scores[k];
      var cls = v>=80?'score-high':v>=50?'score-mid':v>0?'score-low':'score-zero';
      var col = v>=80?'#107c10':v>=50?'#0078d4':v>0?'#ca5010':'#a0a0a0';
      return '<div class="pop-score-row"><div class="pop-score-row-hdr"><span class="pop-score-label">'+k+'</span><span class="pop-score-val" style="color:'+col+'">'+v+'%</span></div><div class="pop-bar-bg"><div class="pop-bar-fill '+cls+'" style="width:'+v+'%"></div></div></div>';
    }).join('');
    html += '<div class="ai-panel"><div class="ai-panel-hdr"><div class="ai-panel-icon">&#9889;</div><div><div class="ai-panel-title">AI Assignment Insight &mdash; '+methodLabel+'</div><div class="ai-panel-sub">Confidence: '+aiInfo.score+'%'+(analyst?' &bull; '+analyst.name:'')+'</div></div></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;"><div><div class="pop-scores">'+barsHTML+'</div></div>'
      +'<div><div class="pop-reasoning" style="margin-bottom:10px;">'+aiInfo.reasoning+'</div>'
      +'<div style="background:var(--teal-light);border:1px solid #b0dfe0;border-radius:4px;padding:10px 12px;"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--teal);margin-bottom:4px;">&#9200; Est. Resolution</div><div style="font-size:22px;font-weight:700;font-family:var(--font-mono);color:var(--teal);">'+aiInfo.eta+' min</div></div></div></div>'
      +'<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">'
      +(aiInfo.strengths||[]).map(function(s){return '<span class="sug-tag strength">&#10003; '+s+'</span>';}).join('')
      +(aiInfo.risks||[]).map(function(r){return '<span class="sug-tag risk">&#9888; '+r+'</span>';}).join('')
      +'</div></div>';
  } else if (!t.assignee) {
    html += '<div class="ai-panel"><div class="ai-panel-hdr"><div class="ai-panel-icon">&#9889;</div><div><div class="ai-panel-title">AI Assignment</div><div class="ai-panel-sub">This task is unassigned.</div></div><div style="margin-left:auto;display:flex;gap:8px;"><button class="btn btn-ai btn-sm" onclick="openAISuggest(\''+t.id+'\')">&#9889; Get AI Suggestions</button></div></div></div>';
  }

  // Failed Outcomes tab
  html += '<div class="modal-tabs"><div class="modal-tab active" onclick="switchTab(this,\'tab-outcomes\')">Failed Outcomes ('+t.open+' open)</div><div class="modal-tab" onclick="switchTab(this,\'tab-guide\')">Resolution Guide</div></div>';
  html += '<div id="tab-outcomes"><div class="table-card" style="margin-bottom:16px;"><table class="outcomes-tbl"><thead><tr><th>ID</th><th>Validated Field</th><th>Rule</th><th>Severity</th><th>Status</th><th>Action</th></tr></thead><tbody>';
  if (outcomesData.length) {
    outcomesData.forEach(function(o){
      var sevCls = o.severity==='Warning'?'b-medium':'b-critical';
      var st = o.status || 'In Task';
      var stCls = st==='Resolved'?'b-resolved':st==='Obsoleted'?'b-blocked':st==='Superseded'?'b-medium':'b-active';
      var actionHTML = '';
      if (st !== 'Resolved' && st !== 'Obsoleted' && st !== 'Superseded') {
        actionHTML = '<select class="form-input" style="font-size:11px;padding:2px 4px;width:auto;" onchange="changeOutcomeStatus(\''+t.id+'\',\''+o.id+'\',this.value)">'
          +'<option value="">Action...</option>'
          +'<option value="Resolved">Resolve</option>'
          +'<option value="Obsoleted">Obsolete</option>'
          +'<option value="Superseded">Supersede</option>'
          +'</select>';
      } else {
        actionHTML = '<span style="color:var(--green);font-size:12px;">&#10003; '+st+'</span>';
      }
      html += '<tr><td class="mono" style="font-size:11px;color:var(--text3);">'+(o.id||'')+'</td>'
        +'<td><strong>'+(o.validated_field||'')+'</strong></td>'
        +'<td><span style="font-family:var(--font-mono);font-size:10px;background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:3px;">'+(o.rule_description||'')+'</span></td>'
        +'<td><span class="badge '+sevCls+'">'+(o.severity||'')+'</span></td>'
        +'<td><span class="badge '+stCls+'">'+st+'</span></td>'
        +'<td>'+actionHTML+'</td></tr>';
    });
  } else {
    html += '<tr><td colspan="6"><div class="empty-state"><div class="empty-text">No failed outcomes found for this task.</div></div></td></tr>';
  }
  html += '</tbody></table></div>';
  if (t.status !== 'Resolved' && t.status !== 'Closed') {
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;">'
      +'<button class="btn btn-danger btn-sm" onclick="setTaskStatus(\''+t.id+'\',\'Blocked\')">Mark Blocked</button>'
      +'<button class="btn btn-primary" onclick="resolveTask(\''+t.id+'\')">&#10003; Mark All Resolved</button></div>';
  }
  html += '</div>';

  // Resolution Guide tab (placeholder)
  html += '<div id="tab-guide" style="display:none;"><div class="res-guide"><div class="res-guide-title">Resolution Guide</div><div class="pop-reasoning">Resolution guides will be loaded from Supabase. For now, consult your team lead or the Knowledge Base.</div></div></div>';

  // Manual assign
  var qElig = ANALYSTS.filter(function(a){ return a.queue_ids_raw && a.queue_ids_raw.indexOf(t.queue_id_raw)>-1; });
  html += '<div id="manual-assign-sec" style="display:none;margin-top:12px;"><div class="divider"></div><div class="sec-title">Manual Assignment</div><div style="display:flex;align-items:center;gap:10px;"><select class="form-input" id="manual-analyst-sel" style="width:200px;">'
    +qElig.map(function(a){return '<option value="'+a.id+'">'+a.name+'</option>';}).join('')
    +'</select><button class="btn btn-primary btn-sm" onclick="assignManual(\''+t.id+'\')">Assign</button><button class="btn btn-default btn-sm" onclick="document.getElementById(\'manual-assign-sec\').style.display=\'none\'">Cancel</button></div></div>';

  html += '</div>'; // modal-body
  document.getElementById('task-modal-body').innerHTML = html;
  openModal('task-overlay');
}

function switchTab(el, tabId) {
  document.querySelectorAll('#task-modal-body .modal-tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  ['tab-outcomes','tab-guide'].forEach(function(tid){
    var el2 = document.getElementById(tid);
    if (el2) el2.style.display = tid===tabId ? 'block' : 'none';
  });
}

// ── Outcome status change (In Task → Resolved / Obsoleted / Superseded) ──
async function changeOutcomeStatus(taskId, outcomeId, newStatus) {
  if (!newStatus) return;
  var now = new Date().toISOString();
  var updateData = { status: newStatus, updated_at: now };
  if (newStatus === 'Resolved') updateData.resolved_at = now;

  var res = await sb.from('failed_outcomes').update(updateData).eq('id', outcomeId);
  if (res.error) { notify('Error', 'Outcome update failed: '+res.error.message, 'error'); return; }

  // Recalculate open count: only 'In Task' outcomes count as open
  var foRes = await sb.from('failed_outcomes').select('id,status').eq('task_id', taskId);
  var allFO = foRes.data || [];
  var openCount = allFO.filter(function(o){ return o.status === 'In Task'; }).length;

  var t = TASKS.find(function(x){ return x.id===taskId; });
  if (t) {
    t.open = openCount;
    await sb.from('tasks').update({ open_count: openCount, updated_at: now }).eq('id', taskId);
  }
  notify('Outcome Updated', 'Outcome marked as '+newStatus+'.', 'success');
  openTask(taskId);
  renderTasks();
}

async function resolveTask(taskId) {
  var t = TASKS.find(function(x){ return x.id===taskId; });
  if (!t) return;
  var now = new Date().toISOString();
  var prevStatus = t.status;

  // Mark all non-terminal outcomes as Resolved
  await sb.from('failed_outcomes').update({ status:'Resolved', resolved_at:now })
    .eq('task_id', taskId).in('status', ['In Task']);

  // Update task with resolved timestamp
  t.status = 'Resolved'; t.open = 0;
  await sb.from('tasks').update({
    status: 'Resolved', open_count: 0,
    resolved_at: now, updated_at: now
  }).eq('id', taskId);

  // Log status change for time tracking
  await sb.from('task_status_log').insert({
    task_id: taskId, from_status: prevStatus, to_status: 'Resolved',
    changed_by: t.assignee, changed_at: now
  }).then(function(r){ if(r.error) console.warn('Status log:', r.error); });

  // Decrement analyst workload
  if (t.assignee) {
    var analyst = getAnalyst(t.assignee);
    if (analyst) {
      analyst.active = Math.max(0, analyst.active - 1);
      await sb.from('analysts').update({ active_tasks:analyst.active, updated_at:now }).eq('id', t.assignee);
    }
  }

  // Log to resolution_history (for AI learning)
  var resMins = Math.round((new Date() - t.created) / 60000);
  await sb.from('resolution_history').insert({
    task_id: taskId,
    analyst_id: t.assignee,
    queue_id: t.queue_id_raw,
    field: t.field,
    rule: t.rule,
    resolution_mins: resMins,
    outcomes_fixed: t.outcomes,
    resolved_at: now
  }).then(function(r){ if(r.error) console.warn('Resolution history:', r.error); });

  notify('Task Resolved', t.ref+' fully resolved in '+resMins+' min. Logged to history.', 'success');
  closeModal('task-overlay');
  renderTasks();
}

async function setTaskStatus(taskId, status) {
  var t = TASKS.find(function(x){ return x.id===taskId; });
  if (!t) return;
  var now = new Date().toISOString();
  var prevStatus = t.status;
  t.status = status;

  // Build update with timestamp for each status
  var updateData = { status: status, updated_at: now };
  if (status === 'Active') updateData.activated_at = now;
  if (status === 'Blocked') updateData.blocked_at = now;
  if (status === 'Closed') updateData.closed_at = now;
  if (status === 'Resolved') updateData.resolved_at = now;

  await sb.from('tasks').update(updateData).eq('id', taskId);

  // Log status change for time tracking
  await sb.from('task_status_log').insert({
    task_id: taskId, from_status: prevStatus, to_status: status,
    changed_by: t.assignee, changed_at: now
  }).then(function(r){ if(r.error) console.warn('Status log:', r.error); });

  notify('Status Updated', t.ref+' marked as '+status+'.', 'info');
  openTask(taskId);
  renderTasks();
}

async function assignManual(taskId) {
  var selId = document.getElementById('manual-analyst-sel').value;
  await doAssign(taskId, selId, 'MANUAL', null);
  closeModal('task-overlay');
  renderTasks();
}

// ── AI Assignment: Agentic LLM ──────────────────────────────────
// Strategy: Minimal prerequisite filter (same queue + domain) → AI Agent does ALL heavy lifting
async function getAISuggestions(taskId) {
  var t = TASKS.find(function(x){ return x.id===taskId; });
  if (!t) return [];

  // Prerequisite filter only: same queue AND same domain
  var eligible = getEligibleAnalysts(t);

  // Pre-fetch resolution history for this field type (used by ALL scoring paths)
  var histRes = await sb.from('resolution_history').select('analyst_id,resolution_mins,outcomes_fixed,field').eq('field', t.field || '');
  var _fieldHistMap = {};
  (histRes.data || []).forEach(function(r){
    if (!_fieldHistMap[r.analyst_id]) _fieldHistMap[r.analyst_id] = { count: 0, total_mins: 0, total_fixed: 0 };
    _fieldHistMap[r.analyst_id].count++;
    _fieldHistMap[r.analyst_id].total_mins += r.resolution_mins || 0;
    _fieldHistMap[r.analyst_id].total_fixed += r.outcomes_fixed || 0;
  });

  // If n8n ON → send eligible analysts with RAW data, AI Agent scores & ranks
  if (CFG.useN8n && N8N_ASSIGN_URL && N8N_ASSIGN_URL.length > 5) {
    try {
      // Fetch failed outcomes so AI Agent knows WHAT needs fixing
      var foRes = await sb.from('failed_outcomes').select('id,validated_field,failed_value,rule_description,severity,validation_stage,status').eq('task_id', taskId);
      var failedOutcomes = (foRes.data || []).map(function(fo){
        return {
          id: fo.id, field: fo.validated_field, value: fo.failed_value,
          rule: fo.rule_description, severity: fo.severity,
          stage: fo.validation_stage, status: fo.status
        };
      });

      var payload = {
        task_id: taskId,
        mode: 'suggest',
        task_context: {
          ref: t.ref, queue: t.queue, queue_id: t.queue_id_raw,
          priority: t.priority, field: t.field, rule: t.rule,
          description: t.desc, domain_id: t.domain_id_raw,
          domain: t.domain,
          sla_deadline: t.sla ? t.sla.toISOString() : null,
          sla_hours_remaining: t.sla ? Math.max(0, Math.round((t.sla - new Date()) / 3600000 * 10) / 10) : null,
          outcomes_count: t.outcomes_count || 0, open_count: t.open_count || 0,
          status: t.status
        },
        failed_outcomes: failedOutcomes,
        scoring_weights: getWeights(),
        not_recommended_threshold: CFG.notRecThreshold || 50,
        eligible_analysts: eligible.map(function(a){
          var wh = isInWorkingHours(a);
          var upcoming = getUpcomingLeaves(a.id);
          var hist = _fieldHistMap[a.id];
          return {
            analyst_id: a.id, name: a.name,
            active_tasks: a.active,
            experience_yrs: a.exp,
            speciality: a.skills,
            queues: a.queues,
            country: a.country || null,
            avg_resolution_mins: a.avg_resolution_mins || null,
            working_hrs_from: a.wh_from || null,
            working_hrs_to: a.wh_to || null,
            timezone: a.tz || null,
            in_working_hours: wh.inHours,
            working_hrs_label: wh.label,
            on_leave_today: isOnLeaveToday(a.id),
            temp_unavailable: isTempUnavailable(a.id),
            temp_unavailable_until: a.temp_unavail ? a.temp_unavail.toISOString() : null,
            leave_note: getLeaveNote(a.id),
            upcoming_leaves: upcoming.map(function(lv){ return { from: lv.date_from, to: lv.date_to, type: lv.type }; }),
            field_history: hist ? {
              tasks_resolved: hist.count,
              avg_resolution_mins: Math.round(hist.total_mins / hist.count),
              total_outcomes_fixed: hist.total_fixed,
              avg_outcomes_per_task: Math.round(hist.total_fixed / hist.count)
            } : null
          };
        })
      };
      var resp = await fetch(N8N_ASSIGN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        var rawText = await resp.text();
        console.log('[n8n] Raw response (first 800 chars):', rawText.substring(0, 800));
        var suggestions = _extractN8nSuggestions(rawText);
        console.log('[n8n] Parsed suggestions:', suggestions.length, 'analysts', suggestions.map(function(s){ return (s.analyst_id||s.aid||'?')+':'+s.overall_score; }));
        // Filter out malformed entries (no analyst_id AND no name)
        suggestions = suggestions.filter(function(s){
          return s.analyst_id || s.aid || s.name;
        });
        if (suggestions.length) {
          // Normalize analyst IDs: the AI may return name, email, or other format
          // Match back to eligible analyst IDs to avoid rendering failures
          suggestions.forEach(function(s, i){
            var rawId = (s.analyst_id || s.aid || '').toString().trim();
            s.rank = i+1;
            s.score = s.overall_score || s.score;
            var matched = null;
            // Try exact ID match first
            if (rawId && rawId !== 'undefined') {
              matched = eligible.find(function(a){ return a.id === rawId; });
              if (!matched) {
                // Try name match (case-insensitive)
                var lower = rawId.toLowerCase();
                matched = eligible.find(function(a){ return a.name && a.name.toLowerCase() === lower; });
              }
              if (!matched) {
                // Try partial match: ID contains or name contains
                matched = eligible.find(function(a){
                  return rawId.indexOf(a.id) > -1 || (a.name && rawId.toLowerCase().indexOf(a.name.toLowerCase()) > -1);
                });
              }
            }
            if (!matched && s.name) {
              // Match by the name field in the AI response
              var sName = (s.name || '').toString().toLowerCase().trim();
              if (sName) matched = eligible.find(function(a){ return a.name && a.name.toLowerCase() === sName; });
            }
            s.aid = matched ? matched.id : rawId;
            s.analyst_id = s.aid;
            if (!matched) console.warn('[n8n] ID mismatch — rawId:', rawId, 'name:', s.name, 'keys:', Object.keys(s).join(','));
            // Propagate not_recommended_reasons from n8n response
            if (s.not_recommended && !s.not_recommended_reasons) s.not_recommended_reasons = ['Below threshold (AI)'];
            if (!s.not_recommended_reasons) s.not_recommended_reasons = [];
          });
          // Remove unmatched + dedup
          var seenIds = {};
          suggestions = suggestions.filter(function(s){
            // Drop entries that couldn't be matched to any eligible analyst
            if (!getAnalyst(s.aid)) {
              console.warn('[n8n] Dropping unmatched entry:', s.aid);
              return false;
            }
            if (seenIds[s.aid]) return false;
            seenIds[s.aid] = true;
            return true;
          });
          console.log('[n8n] After normalization:', suggestions.length, 'valid suggestions:', suggestions.map(function(s){ return s.aid+':'+s.score; }));
          if (suggestions.length) {
            _lastScoringEngine = 'n8n';
            // Use n8n response for ALL analysts; supplement missing ones with local scoring
            var n8nIds = suggestions.map(function(s){ return s.aid; });
            var localAll = localScoring(t, _fieldHistMap);
            var supplemented = localAll.filter(function(s){ return n8nIds.indexOf(s.aid) === -1; });
            supplemented.forEach(function(s){ s.rank = suggestions.length + s.rank; });
            _lastAllScored = suggestions.concat(supplemented);
            // Return top recommended (not marked as not_recommended by AI)
            var recommended = suggestions.filter(function(s){ return !s.not_recommended; });
            return recommended.slice(0, 3).length ? recommended.slice(0, 3) : suggestions.slice(0, 3);
          }
          console.warn('[n8n] All suggestions dropped after ID normalization — falling back to local scoring');
        }
      }
      console.warn('n8n LLM returned no suggestions (status '+resp.status+')');
    } catch(e) {
      console.warn('n8n AI Agent unavailable:', e);
    }
    // n8n was ON but failed — fall back to local scoring
    _lastScoringEngine = 'local';
    var fallback = localScoring(t, _fieldHistMap);
    _lastAllScored = fallback;
    return fallback.slice(0, 3);
  }

  // n8n OFF: local scoring fallback
  var allScored = localScoring(t, _fieldHistMap);
  _lastScoringEngine = 'local';
  _lastAllScored = allScored;
  return allScored.slice(0, 3);
}

// Robust n8n response extractor — handles any wrapper format
function _extractN8nSuggestions(rawText) {
  var text = (rawText || '').trim();
  // Strip markdown code fences
  if (text.indexOf('```') > -1) {
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  }
  // Helper: check if value looks like our analyst suggestion array
  function looksLikeSuggestions(arr) {
    return Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object'
      && (arr[0].analyst_id || arr[0].aid || arr[0].overall_score !== undefined || arr[0].scores);
  }
  // Helper: recursively search an object for an analyst array
  function deepFind(obj, depth) {
    if (depth > 5) return null;
    if (looksLikeSuggestions(obj)) return obj;
    if (Array.isArray(obj)) {
      // Array of wrapper objects? Check first element
      if (obj.length && typeof obj[0] === 'object' && !looksLikeSuggestions(obj)) {
        for (var ai = 0; ai < obj.length; ai++) {
          var found = deepFind(obj[ai], depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    if (obj && typeof obj === 'object') {
      // Check known keys first
      var keys = ['suggestions','output','data','result','response','text','message','content','body','choices'];
      for (var ki = 0; ki < keys.length; ki++) {
        if (obj[keys[ki]] !== undefined) {
          var val = obj[keys[ki]];
          if (typeof val === 'string') {
            var parsed = _tryParseJSON(val);
            if (parsed) {
              var found = deepFind(parsed, depth + 1);
              if (found) return found;
            }
          } else {
            var found2 = deepFind(val, depth + 1);
            if (found2) return found2;
          }
        }
      }
      // Check all other keys
      var allKeys = Object.keys(obj);
      for (var oi = 0; oi < allKeys.length; oi++) {
        if (keys.indexOf(allKeys[oi]) > -1) continue; // already checked
        var v = obj[allKeys[oi]];
        if (typeof v === 'string') {
          var p = _tryParseJSON(v);
          if (p) { var f = deepFind(p, depth + 1); if (f) return f; }
        } else if (typeof v === 'object' && v) {
          var f2 = deepFind(v, depth + 1); if (f2) return f2;
        }
      }
    }
    return null;
  }
  // Helper: try to parse JSON string, stripping fences
  function _tryParseJSON(str) {
    if (!str || typeof str !== 'string') return null;
    var s = str.trim();
    if (s.indexOf('```') > -1) s = s.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // Try to find JSON array or object in the string
    var start = -1;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '[' || s[i] === '{') { start = i; break; }
    }
    if (start > 0) s = s.substring(start);
    try { return JSON.parse(s); } catch(e) { return null; }
  }
  // Step 1: Try parsing the entire text as JSON
  var parsed = _tryParseJSON(text);
  if (parsed) {
    var result = deepFind(parsed, 0);
    if (result) { console.log('[n8n] Extracted from parsed JSON'); return result; }
    // If parsed is an array but doesn't look like suggestions, check if items have nested text
    if (Array.isArray(parsed) && parsed.length) {
      for (var pi = 0; pi < parsed.length; pi++) {
        var inner = deepFind(parsed[pi], 0);
        if (inner) return inner;
      }
    }
  }
  // Step 2: Try to find a JSON array directly in the raw text
  var arrStart = text.indexOf('[');
  if (arrStart > -1) {
    var arrText = text.substring(arrStart);
    var arrParsed = _tryParseJSON(arrText);
    if (looksLikeSuggestions(arrParsed)) { console.log('[n8n] Extracted from raw text array'); return arrParsed; }
  }
  // Step 3: Try to find a JSON object in the raw text
  var objStart = text.indexOf('{');
  if (objStart > -1) {
    var objText = text.substring(objStart);
    var objParsed = _tryParseJSON(objText);
    if (objParsed) {
      var objResult = deepFind(objParsed, 0);
      if (objResult) { console.log('[n8n] Extracted from raw text object'); return objResult; }
    }
  }
  console.warn('[n8n] Could not extract suggestions from response');
  return [];
}

// Pre-filter: same queue AND same domain (prerequisites only)
function getEligibleAnalysts(task) {
  return ANALYSTS.filter(function(a){
    var queueMatch = a.queue_ids_raw && a.queue_ids_raw.indexOf(task.queue_id_raw) > -1;
    var domainMatch = !task.domain_id_raw || !a.domain_ids_raw || !a.domain_ids_raw.length
      || a.domain_ids_raw.indexOf(task.domain_id_raw) > -1;
    return queueMatch && domainMatch;
  });
}

// Local scoring fallback (used when n8n is OFF)
// 6 dimensions with configurable weights
function getWeights() {
  var def = { Availability: 20, Workload: 20, Speciality: 20, 'Working Hours': 15, 'Resolution History': 13, 'SLA Fit': 12 };
  if (CFG.scoringWeights) return Object.assign({}, def, CFG.scoringWeights);
  return def;
}
var SCORING_DIMS = ['Availability','Workload','Speciality','Working Hours','Resolution History','SLA Fit'];
function localScoring(task, fieldHistMap) {
  var eligible = getEligibleAnalysts(task);
  var W = getWeights();
  var wSum = 0;
  SCORING_DIMS.forEach(function(d){ wSum += (W[d] || 0); });
  wSum = wSum || 100;
  var fhm = fieldHistMap || {};

  // Team average active tasks for relative workload comparison
  var totalActive = eligible.reduce(function(s, a){ return s + a.active; }, 0);
  var avgActive = eligible.length ? totalActive / eligible.length : 1;

  var scored = eligible.map(function(a){
    var onLeave = isOnLeaveToday(a.id);
    var tempAway = isTempUnavailable(a.id);
    var availScore = (onLeave || tempAway) ? 25 : 100;
    var availDetail = tempAway ? 'Temp Away' : (onLeave ? 'On Leave' : 'Available');

    // Workload: fewer active tasks = higher score (relative to team average)
    var workloadScore = avgActive > 0
      ? Math.max(0, Math.min(100, Math.round((1 - (a.active / (avgActive * 2))) * 100)))
      : (a.active === 0 ? 100 : 50);
    var workloadDetail = a.active + ' active task' + (a.active !== 1 ? 's' : '') + ' (avg: ' + Math.round(avgActive) + ')';

    // Resolution History: has analyst resolved similar field-type tasks before?
    var hist = fhm[a.id];
    var resHistScore = 0;
    var resHistDetail = 'No past ' + (task.field || 'field') + ' resolutions';
    if (hist && hist.count > 0) {
      // Score based on count of similar resolutions (max 100 at 5+ resolutions)
      var countScore = Math.min(100, hist.count * 20);
      // Bonus for outcomes fixed
      var outcomeScore = Math.min(100, hist.total_fixed * 5);
      // Speed bonus: faster avg = higher score
      var avgMins = hist.total_mins / hist.count;
      var speedScore = avgMins <= 30 ? 100 : avgMins <= 60 ? 80 : avgMins <= 120 ? 60 : 40;
      resHistScore = Math.round(countScore * 0.4 + outcomeScore * 0.3 + speedScore * 0.3);
      resHistDetail = hist.count + ' resolved, ' + hist.total_fixed + ' outcomes fixed, avg ' + Math.round(avgMins) + ' min';
    }

    // Speciality: HYBRID — check static speciality[] AND dynamic resolution history
    var matchedSkills = (a.skills || []).filter(function(s){
      return task.field && s.toLowerCase().indexOf(task.field.toLowerCase()) > -1;
    });
    var hasStaticSpec = matchedSkills.length > 0;
    var hasDynamicSpec = hist && hist.count > 0;
    var specScore, specDetail;
    if (hasStaticSpec && hasDynamicSpec) {
      specScore = 100;
      specDetail = matchedSkills.join(', ') + ' + ' + hist.count + ' past resolutions';
    } else if (hasDynamicSpec) {
      specScore = 85; // proven by doing, even without static tag
      specDetail = hist.count + ' past ' + (task.field || '') + ' resolutions (no static tag)';
    } else if (hasStaticSpec) {
      specScore = 70; // tagged but no proven track record yet
      specDetail = matchedSkills.join(', ') + ' (no past resolutions)';
    } else {
      specScore = 20;
      specDetail = 'No ' + (task.field || 'field') + ' expertise';
    }

    // Working Hours: is analyst currently within their working hours?
    var wh = isInWorkingHours(a);
    var whScore = wh.label === 'Not Set' ? 70 : (wh.inHours ? 100 : 20);
    var whDetail = wh.label === 'Not Set' ? 'Not configured' : (wh.label + (a.tz ? ' ' + formatTZ(a.tz) : ''));

    // SLA Fit: urgent tasks favour faster analysts
    var slaMs = task.sla - new Date();
    var slaHrs = Math.max(0, Math.round(slaMs / 3600000 * 10) / 10);
    var slaScore = slaMs < 0 ? 100 : slaMs < 7200000 ? 80 : 60;
    // Boost SLA score if analyst has fast resolution history for this field
    if (hist && hist.count > 0) {
      var fieldAvgMins = hist.total_mins / hist.count;
      if (fieldAvgMins <= 30) slaScore = Math.min(100, slaScore + 20);
      else if (fieldAvgMins <= 60) slaScore = Math.min(100, slaScore + 10);
    }
    var avgRes = a.avg_resolution_mins || 'N/A';
    var slaDetail = (slaMs < 0 ? 'Overdue' : slaHrs + 'h left') + ' · Avg res: ' + avgRes + (typeof avgRes === 'number' ? ' min' : '');

    var overall = Math.round(
      (availScore * (W.Availability||0) + workloadScore * (W.Workload||0) +
      specScore * (W.Speciality||0) + whScore * (W['Working Hours']||0) +
      resHistScore * (W['Resolution History']||0) + slaScore * (W['SLA Fit']||0)) / wSum
    );

    var scoreDetails = {
      'Availability': availDetail,
      'Workload': workloadDetail,
      'Speciality': specDetail,
      'Working Hours': whDetail,
      'Resolution History': resHistDetail,
      'SLA Fit': slaDetail
    };

    var strengths = [];
    var risks = [];
    if (hasStaticSpec || hasDynamicSpec) strengths.push((task.field||'Field')+' Expert' + (hasDynamicSpec ? ' (proven)' : ''));
    if (hist && hist.count >= 3) strengths.push(hist.count + ' Past Resolutions');
    if (hist && hist.total_fixed >= 10) strengths.push(hist.total_fixed + ' Outcomes Fixed');
    if (a.active === 0) strengths.push('No Active Tasks');
    else if (a.active <= 2) strengths.push('Low Workload ('+a.active+' tasks)');
    if (availScore === 100) strengths.push('Available Today');
    if (wh.inHours && wh.label !== 'Not Set') strengths.push('In Working Hours');
    if (onLeave) risks.push('On Leave Today');
    if (tempAway) risks.push('Temporarily Away');
    if (!wh.inHours && wh.label !== 'Not Set') risks.push('Outside Working Hours');
    if (a.active > avgActive * 1.5) risks.push('Above Avg Workload ('+a.active+' tasks)');
    if (!hasStaticSpec && !hasDynamicSpec && task.field) risks.push('No ' + task.field + ' Experience');

    var availText = tempAway ? ' is temporarily away (back soon).' : (onLeave ? ' is on leave today but can start when back.' : ' is available today.');
    var histText = hasDynamicSpec ? ' Has resolved ' + hist.count + ' similar ' + (task.field||'') + ' tasks (' + hist.total_fixed + ' outcomes fixed, avg ' + Math.round(hist.total_mins / hist.count) + ' min).' : '';
    var specText = hasStaticSpec ? ' Tagged with ' + matchedSkills.join(', ') + ' speciality.' : (hasDynamicSpec ? ' Proven expertise through past resolutions.' : ' No specific '+(task.field||'field')+' expertise.');
    var reasoning = a.name + availText +
      ' Current workload: '+a.active+' active task'+(a.active!==1?'s':'')+'.' +
      specText + histText +
      (wh.label !== 'Not Set' ? (wh.inHours ? ' Currently in working hours.' : ' Currently outside working hours ('+wh.label+' '+formatTZ(a.tz)+').') : '');

    var notRecommendedReasons = [];
    if (onLeave) notRecommendedReasons.push('On leave today — can start when back, scored lower');
    if (tempAway) notRecommendedReasons.push('Temporarily away — will return soon');
    if (!wh.inHours && wh.label !== 'Not Set') notRecommendedReasons.push('Outside working hours ('+wh.label+' '+formatTZ(a.tz)+')');
    if (a.active > avgActive * 1.5) notRecommendedReasons.push('Above average workload ('+a.active+' active tasks)');
    if (!hasStaticSpec && !hasDynamicSpec && task.field) notRecommendedReasons.push('No '+task.field+' expertise (static or historical)');

    // Estimated resolution time calculation with breakdown
    var estMin, estBreakdown;
    var taskOutcomes = task.outcomes || task.outcomes_count || 0;
    if (hist && hist.count > 0) {
      var fieldAvg = Math.round(hist.total_mins / hist.count);
      var avgOutPerTask = hist.total_fixed / hist.count;
      if (taskOutcomes > 0 && avgOutPerTask > 0) {
        estMin = Math.round((taskOutcomes / avgOutPerTask) * fieldAvg);
        estBreakdown = 'Based on ' + hist.count + ' past ' + (task.field||'') + ' resolutions: avg ' + fieldAvg + ' min/task, ~' + Math.round(avgOutPerTask) + ' outcomes/task. This task has ' + taskOutcomes + ' outcomes → (' + taskOutcomes + '/' + Math.round(avgOutPerTask) + ') × ' + fieldAvg + ' = ' + estMin + ' min.';
      } else {
        estMin = fieldAvg;
        estBreakdown = 'Based on ' + hist.count + ' past ' + (task.field||'') + ' resolutions: avg resolution time ' + fieldAvg + ' min.';
      }
    } else if (a.avg_resolution_mins) {
      estMin = a.avg_resolution_mins;
      estBreakdown = 'No past ' + (task.field||'field') + ' history. Using analyst general avg resolution time: ' + a.avg_resolution_mins + ' min.';
    } else {
      estMin = 60;
      estBreakdown = 'No resolution data available for this analyst. Default estimate: 60 min.';
    }

    return {
      analyst_id: a.id, aid: a.id, rank: 0,
      overall_score: overall, score: overall,
      scores: { 'Availability':availScore, 'Workload':workloadScore, 'Speciality':specScore, 'Working Hours':whScore, 'Resolution History':resHistScore, 'SLA Fit':slaScore },
      score_details: scoreDetails,
      reasoning: reasoning,
      strengths: strengths, risks: risks,
      not_recommended_reasons: notRecommendedReasons,
      est_resolution_min: estMin,
      est_breakdown: estBreakdown
    };
  });

  scored.sort(function(a,b){ return b.overall_score - a.overall_score; });
  return scored.map(function(s, i){
    s.rank = i + 1;
    return s;
  });
}


// ── Estimated Time Helpers ───────────────────────────────────────
function _fmtEta(mins) {
  if (!mins || mins <= 0) return 'N/A';
  if (mins < 60) return mins + ' min';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
}

function _toggleEstBreakdown(btn) {
  var row = btn.closest('.sug-card') || btn.parentElement.parentElement;
  var bd = row.querySelector('.est-breakdown');
  if (!bd) return;
  var visible = bd.style.display !== 'none';
  bd.style.display = visible ? 'none' : 'block';
  btn.textContent = visible ? '\u2139 How?' : '\u2139 Hide';
}

function _buildN8nBreakdown(s, task) {
  var parts = [];
  var eta = s.est_resolution_min || 0;
  var sd = s.score_details || {};
  var resHist = sd['Resolution History'] || '';
  if (resHist && resHist !== 'No past resolutions' && resHist.indexOf('No past') === -1) {
    parts.push('Resolution history: ' + resHist + '.');
  }
  var specDetail = sd['Speciality'] || '';
  if (specDetail) parts.push('Speciality: ' + specDetail + '.');
  var taskOutcomes = task.outcomes || task.outcomes_count || 0;
  if (taskOutcomes > 0) parts.push('Task has ' + taskOutcomes + ' failed outcomes.');
  if (eta > 0) parts.push('AI estimated resolution time: ' + _fmtEta(eta) + '.');
  if (s.reasoning) {
    var estMatch = s.reasoning.match(/[Ee]stimat(?:ed?|ion)[^.]*\d+[^.]*/);
    if (estMatch) parts.push(estMatch[0].trim() + '.');
  }
  return parts.length ? parts.join(' ') : 'Estimated by AI Agent based on analyst profile, workload, and task complexity.';
}

// ── AI Suggest Modal ────────────────────────────────────────────
async function openAISuggest(taskId) {
  var t = TASKS.find(function(x){ return x.id===taskId; });
  if (!t) return;
  _aiTaskId = taskId;
  var sla = getSLA(t);
  var queueAnalysts = getEligibleAnalysts(t);

  // Show loading
  var n8nConfigured = CFG.useN8n && N8N_ASSIGN_URL && N8N_ASSIGN_URL.length > 5;
  var modeLabel = n8nConfigured ? 'Calling n8n AI Agent at '+N8N_ASSIGN_URL.replace(/https?:\/\//, '').split('/')[0]+'...' : 'Using local scoring engine';
  document.getElementById('ai-modal-body').innerHTML = '<div class="modal-header"><div><div class="modal-title">&#9889; AI Assignment Suggestions</div><div class="modal-subtitle">'+t.ref+' &bull; '+t.queue+' &bull; '+t.priority+'</div></div><div class="modal-close" onclick="closeModal(\'ai-overlay\')">&#10005;</div></div><div class="modal-body"><div class="ai-loading"><div class="spinner-sm"></div><div>Analysing '+queueAnalysts.length+' eligible analysts...</div><div style="font-size:11px;color:var(--text4);margin-top:4px;">'+modeLabel+'</div></div></div>';
  openModal('ai-overlay');

  // Get suggestions (skip local fallback when n8n toggle is ON)
  var sugs = await getAISuggestions(taskId);
  _aiSugs = sugs;

  // If n8n toggle is ON but n8n failed — show error + manual assign only
  if (n8nConfigured && _lastScoringEngine !== 'n8n') {
    var errHtml = '<div class="modal-header"><div><div class="modal-title">&#9889; AI Assignment Suggestions</div>'
      +'<div class="modal-subtitle">'+t.ref+' &bull; '+t.queue+' &bull; '+t.priority+' Priority &bull; SLA: '+sla.txt+'</div></div>'
      +'<div class="modal-close" onclick="closeModal(\'ai-overlay\')">&#10005;</div></div><div class="modal-body">'
      +'<div style="background:#fde7e9;border:1px solid #e8a0a5;border-radius:6px;padding:16px 18px;margin-bottom:20px;font-size:13px;color:#a4262c;">'
      +'<strong>&#9888; n8n AI Agent call failed</strong><br>'
      +'<span style="font-size:12px;">The n8n workflow at <code>'+N8N_ASSIGN_URL.replace(/https?:\/\//, '').split('/')[0]+'</code> did not return valid suggestions. '
      +'Please check that the n8n workflow is active and all nodes are configured correctly.</span></div>'
      +'<div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:16px 18px;margin-bottom:12px;">'
      +'<div style="font-size:13px;font-weight:600;margin-bottom:10px;">Assign manually ('+t.queue+' queue):</div>'
      +'<div style="display:flex;align-items:center;gap:10px;">'
      +'<select class="form-input" id="ai-manual-sel" style="width:220px;">'
      +queueAnalysts.map(function(a){return '<option value="'+a.id+'">'+a.name+'</option>';}).join('')
      +'</select><button class="btn btn-primary btn-sm" onclick="pickManual()">Assign</button></div></div>'
      +'<div style="font-size:11px;color:var(--text4);margin-top:8px;">Tip: Turn off the n8n toggle in <span style="color:var(--blue);cursor:pointer;font-weight:600;" onclick="closeModal(\'ai-overlay\');openConfigModal();">AI Settings</span> to use the built-in local scoring engine instead.</div>'
      +'</div>';
    document.getElementById('ai-modal-body').innerHTML = errHtml;
    return;
  }

  // Save scores to Supabase
  for (var si = 0; si < sugs.length; si++) {
    try {
      await sb.from('ai_assignment_scores').insert({
        task_id: taskId, analyst_id: sugs[si].aid, rank: sugs[si].rank,
        overall_score: sugs[si].overall_score || sugs[si].score,
        scores: sugs[si].scores, reasoning: sugs[si].reasoning,
        strengths: sugs[si].strengths, risks: sugs[si].risks,
        est_resolution_min: sugs[si].est_resolution_min, selected: false
      });
    } catch(e) { console.warn('Score save error:', e); }
  }

  // Calculate average estimated time across all scored analysts
  var allEsts = (_lastAllScored || []).map(function(s){ return s.est_resolution_min || 0; }).filter(function(v){ return v > 0; });
  var avgEst = allEsts.length ? Math.round(allEsts.reduce(function(a,b){ return a+b; }, 0) / allEsts.length) : null;
  var topEst = sugs.length ? (sugs[0].est_resolution_min || null) : null;
  var estHeader = '';
  if (avgEst || topEst) {
    estHeader = '<div style="display:flex;align-items:center;gap:16px;margin-top:6px;">';
    if (avgEst) estHeader += '<span style="font-size:12px;color:var(--text3);">&#128337; Avg Est. Time: <strong style="color:var(--text1);">'+_fmtEta(avgEst)+'</strong></span>';
    if (topEst) estHeader += '<span style="font-size:12px;color:var(--text3);">&#9889; Top Pick Est: <strong style="color:#107c10;">'+_fmtEta(topEst)+'</strong></span>';
    estHeader += '</div>';
  }

  // Render suggestion cards
  var engineLabel = _lastScoringEngine === 'n8n' ? 'Scored by AI Agent via n8n.' : 'Scored by local scoring engine. Enable n8n in AI Settings for agent scoring.';
  var html = '<div class="modal-header"><div><div class="modal-title">&#9889; AI Assignment Suggestions</div>'
    +'<div class="modal-subtitle">'+t.ref+' &bull; '+t.queue+' &bull; '+t.priority+' Priority &bull; SLA: '+sla.txt+'</div>'
    +estHeader
    +'</div>'
    +'<div class="modal-close" onclick="closeModal(\'ai-overlay\')">&#10005;</div></div><div class="modal-body">'
    +'<div style="background:var(--blue-light);border:1px solid #b3d6f5;border-radius:4px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--blue-dark);">'
    +'&#9889; Analysed <strong>'+queueAnalysts.length+' queue-eligible analysts</strong> ('+t.queue+' queue). '
    +engineLabel
    +'</div><div class="suggestions-grid">';

  sugs.forEach(function(s, i){
    var a = getAnalyst(s.aid);
    if (!a) return;
    var rankCls = i===0?'':'r'+(i+1);
    var eta = s.est_resolution_min || 60;
    var scoreKeys = Object.keys(s.scores || {});
    var details = s.score_details || {};
    var barsHTML = scoreKeys.map(function(k){
      var v = s.scores[k];
      var bC = v>=80?'#107c10':v>=50?'#0078d4':v>0?'#ca5010':'#d9d9d9';
      var vC = v>=80?'#107c10':v>=50?'#0078d4':v>0?'#ca5010':'#a0a0a0';
      var detailStr = details[k] ? '<span class="sug-bar-detail">'+details[k]+'</span>' : '';
      return '<div class="sug-bar-row"><div class="sug-bar-row-hdr"><span class="sug-bar-label">'+k+'</span><span class="sug-bar-val-lbl" style="color:'+vC+'">'+v+'%</span>'+detailStr+'</div><div class="sug-bar-bg"><div class="sug-bar-fill" style="width:'+v+'%;background:'+bC+'"></div></div></div>';
    }).join('');
    html += '<div class="sug-card'+(i===0?' top-pick':'')+'"><div class="sug-rank '+rankCls+'">#'+(i+1)+' Pick</div>'
      +'<div class="sug-analyst-row"><div class="av-chip" style="background:'+a.color+'">'+a.initials+'</div><div><div class="sug-name">'+a.name+'</div><div class="sug-exp">'+a.exp+' yrs &bull; '+a.queues.join(', ')+'</div></div><div class="sug-score-big '+rankCls+'">'+(s.overall_score||s.score)+'%</div></div>'
      +'<div class="sug-bars">'+barsHTML+'</div>'
      +'<div class="sug-reasoning">'+(s.reasoning||'')+'</div>'
      +'<div class="sug-tags">'+(s.strengths||[]).map(function(st){return '<span class="sug-tag strength">'+st+'</span>';}).join('')+(s.risks||[]).map(function(r){return '<span class="sug-tag risk">'+r+'</span>';}).join('')+'</div>'
      +'<div class="est-row" style="font-size:11px;color:var(--text3);margin:6px 0 8px;display:flex;align-items:center;gap:6px;">'
      +'<span style="font-family:var(--font-mono);">&#9200; Est: <strong>'+_fmtEta(eta)+'</strong></span>'
      +'<button class="est-info-btn" onclick="_toggleEstBreakdown(this)" title="How was this calculated?">&#9432; How?</button>'
      +'</div>'
      +'<div class="est-breakdown" style="display:none;font-size:11px;color:var(--text3);background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px 10px;margin-bottom:8px;line-height:1.5;">'+(s.est_breakdown || _buildN8nBreakdown(s, t))+'</div>'
      +'<button class="btn '+(i===0?'btn-ai':'btn-default')+' sug-select" onclick="pickSug('+i+')">'+(i===0?'&#9889; Assign (Recommended)':'Assign '+a.name.split(' ')[0])+'</button></div>';
  });

  html += '</div>';

  // ── Not Recommended Section ──
  // Uses threshold: analysts scoring below CFG.notRecThreshold OR ranked beyond top 3
  var sugIds = sugs.map(function(s){ return s.aid; });
  var notRec = (_lastAllScored || []).filter(function(s){
    if (sugIds.indexOf(s.aid) > -1) return false; // already shown as a pick
    return true;
  });
  // Split into below-threshold and above-threshold-but-lower-ranked
  var threshold = CFG.notRecThreshold || 50;
  var belowThreshold = notRec.filter(function(s){ return (s.overall_score || s.score) < threshold; });
  var aboveThreshold = notRec.filter(function(s){ return (s.overall_score || s.score) >= threshold; });
  if (aboveThreshold.length || belowThreshold.length) {
    html += '<div class="divider"></div><div style="margin-bottom:12px;">';
    // Above threshold but lower ranked
    if (aboveThreshold.length) {
      html += '<div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:8px;">&#128269; Other Eligible Analysts — Ranked Lower</div>';
      aboveThreshold.forEach(function(s){
        var a = getAnalyst(s.aid);
        if (!a) return;
        var reasons = (s.not_recommended_reasons && s.not_recommended_reasons.length)
          ? s.not_recommended_reasons.join(' · ')
          : 'Outperformed by higher-ranked analysts';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;">'
          +'<div class="av-chip" style="background:'+a.color+';width:28px;height:28px;font-size:10px;">'+a.initials+'</div>'
          +'<div style="flex:1;min-width:0;">'
          +'<div style="font-size:12px;font-weight:600;color:var(--text2);">'+a.name+' <span style="color:var(--text4);font-weight:400;">— Score: '+(s.overall_score||s.score)+'%</span></div>'
          +'<div style="font-size:11px;color:var(--blue);margin-top:2px;">'+reasons+'</div>'
          +'<div style="font-size:11px;color:var(--text4);margin-top:1px;">'+(s.reasoning||'')+'</div>'
          +'</div></div>';
      });
    }
    // Below threshold
    if (belowThreshold.length) {
      html += '<div style="font-size:13px;font-weight:600;color:#ca5010;margin-bottom:8px;'+(aboveThreshold.length?'margin-top:14px;':'')+'">&#128683; Not Recommended — Score Below '+threshold+'%</div>';
      belowThreshold.forEach(function(s){
        var a = getAnalyst(s.aid);
        if (!a) return;
        var reasons = (s.not_recommended_reasons && s.not_recommended_reasons.length)
          ? s.not_recommended_reasons.join(' · ')
          : 'Score too low for reliable assignment';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:#fde7e9;border:1px solid #f0c0c3;border-radius:6px;margin-bottom:6px;">'
          +'<div class="av-chip" style="background:'+a.color+';width:28px;height:28px;font-size:10px;">'+a.initials+'</div>'
          +'<div style="flex:1;min-width:0;">'
          +'<div style="font-size:12px;font-weight:600;color:var(--text2);">'+a.name+' <span style="color:#ca5010;font-weight:400;">— Score: '+(s.overall_score||s.score)+'%</span></div>'
          +'<div style="font-size:11px;color:#ca5010;margin-top:2px;">'+reasons+'</div>'
          +'<div style="font-size:11px;color:var(--text4);margin-top:1px;">'+(s.reasoning||'')+'</div>'
          +'</div></div>';
      });
    }
    html += '</div>';
  }

  // ── Manual assign fallback ──
  html += '<div class="divider"></div>'
    +'<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:12px;color:var(--text3);">Or assign manually ('+t.queue+' queue):</span>'
    +'<select class="form-input" id="ai-manual-sel" style="width:180px;">'
    +queueAnalysts.map(function(a){return '<option value="'+a.id+'">'+a.name+'</option>';}).join('')
    +'</select><button class="btn btn-default btn-sm" onclick="pickManual()">Assign</button></div></div>';

  document.getElementById('ai-modal-body').innerHTML = html;
}

async function pickSug(idx) {
  if (!_aiTaskId) return;
  var s = _aiSugs[idx];
  if (!s) return;
  // Mark this score as selected
  try {
    await sb.from('ai_assignment_scores').update({selected:true}).eq('task_id',_aiTaskId).eq('analyst_id',s.aid).eq('rank',s.rank);
  } catch(e) { console.warn(e); }
  await doAssign(_aiTaskId, s.aid, idx===0?'AI_AUTO':'AI_SUGGESTED', s);
}
async function pickManual() {
  var sel = document.getElementById('ai-manual-sel');
  if (sel && _aiTaskId) await doAssign(_aiTaskId, sel.value, 'MANUAL', null);
}

// ── Assignment logic ────────────────────────────────────────────
async function doAssign(taskId, analystId, method, scoreObj) {
  var t = TASKS.find(function(x){ return x.id===taskId; });
  var a = getAnalyst(analystId);
  if (!t || !a) return;

  var now = new Date().toISOString();

  // Update task in Supabase
  var updateData = {
    assignee_id: analystId, assigned_by: method, status: 'Active',
    ai_confidence: scoreObj ? (scoreObj.overall_score || scoreObj.score) : null,
    activated_at: now, updated_at: now
  };
  await sb.from('tasks').update(updateData).eq('id', taskId);

  // Log status change for time tracking
  await sb.from('task_status_log').insert({
    task_id: taskId, from_status: t.status, to_status: 'Active',
    changed_by: analystId, changed_at: now
  }).then(function(r){ if(r.error) console.warn('Status log:', r.error); });

  // Increment analyst active_tasks
  a.active = (a.active || 0) + 1;
  await sb.from('analysts').update({ active_tasks: a.active, updated_at: now }).eq('id', analystId);

  // Update local state
  t.assignee = analystId;
  t.assignedBy = method;
  t.status = 'Active';
  t.ai_confidence = updateData.ai_confidence;
  if (scoreObj) t.aiScore = scoreObj;

  closeModal('ai-overlay');
  closeModal('task-overlay');
  if (CFG.showNotif || method === 'AI_AUTO') {
    notify('Task Assigned', t.ref+' assigned to '+a.name+(method!=='MANUAL'?' via '+method.replace('_',' '):''), method==='AI_AUTO'?'success':'info');
  }
  renderTasks();
}

// ── Bulk Auto-Assign (Efficient Agentic LLM) ────────────────────
// Strategy: SQL pre-filter ALL tasks → batch into groups of 10 → 1 LLM call per batch
// For 50 tasks: 5 LLM calls instead of 50 → 10x more efficient
var BATCH_SIZE = 10;

async function bulkAutoAssign() {
  var unassigned = TASKS.filter(function(t){ return !t.assignee && t.status === 'New'; });
  if (!unassigned.length) { notify('No Unassigned Tasks','All tasks have an assignee.','info'); return; }

  var n8nMode = CFG.useN8n && (N8N_BATCH_URL && N8N_BATCH_URL.length > 5 || N8N_ASSIGN_URL && N8N_ASSIGN_URL.length > 5);
  var batchUrl = (N8N_BATCH_URL && N8N_BATCH_URL.length > 5) ? N8N_BATCH_URL : N8N_ASSIGN_URL;

  // Step 1: Prerequisite filter per task (same queue + domain)
  notify('Bulk Assign', 'Filtering eligible analysts for '+unassigned.length+' tasks...', 'info');
  var taskBatches = [];
  var currentBatch = [];
  for (var i = 0; i < unassigned.length; i++) {
    var t = unassigned[i];
    var eligible = getEligibleAnalysts(t);
    currentBatch.push({
      task_id: t.id, ref: t.ref, queue: t.queue, queue_id: t.queue_id_raw,
      priority: t.priority, field: t.field, rule: t.rule,
      description: t.desc, domain_id: t.domain_id_raw, domain: t.domain,
      sla_deadline: t.sla ? t.sla.toISOString() : null,
      outcomes_count: t.outcomes_count || 0,
      eligible_analysts: eligible.map(function(a){
        return {
          analyst_id: a.id, name: a.name,
          active_tasks: a.active, experience_yrs: a.exp,
          speciality: a.skills, on_leave_today: isOnLeaveToday(a.id),
          temp_unavailable: isTempUnavailable(a.id),
          avg_resolution_mins: a.avg_resolution_mins || null
        };
      })
    });
    if (currentBatch.length >= BATCH_SIZE || i === unassigned.length - 1) {
      taskBatches.push(currentBatch);
      currentBatch = [];
    }
  }

  // Step 2: If n8n ON → send batches to LLM (1 call per batch of 10)
  var count = 0;
  var llmFailed = false;
  if (n8nMode) {
    notify('Bulk Assign', 'Sending '+taskBatches.length+' batch'+(taskBatches.length>1?'es':'')+' to AI Agent ('+unassigned.length+' tasks, '+BATCH_SIZE+' per batch)...', 'info');
    for (var b = 0; b < taskBatches.length; b++) {
      var batch = taskBatches[b];
      try {
        var batchResp = await fetch(batchUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'batch_assign', tasks: batch })
        });
        if (batchResp.ok) {
          var batchRaw = await batchResp.text();
          var batchCleaned = batchRaw.trim();
          if (batchCleaned.indexOf('```') > -1) {
            batchCleaned = batchCleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
          }
          var batchData;
          try { batchData = JSON.parse(batchCleaned); } catch(ep) { batchData = null; }
          if (!batchData) { console.warn('Batch '+(b+1)+' parse error'); llmFailed = true; continue; }
          var assignments = Array.isArray(batchData) ? batchData : (batchData.assignments || batchData.output || []);
          if (typeof assignments === 'string') {
            try {
              var ac = assignments.trim();
              if (ac.indexOf('```') > -1) ac = ac.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
              assignments = JSON.parse(ac);
            } catch(e2) { assignments = []; }
          }
          for (var j = 0; j < assignments.length; j++) {
            var asn = assignments[j];
            var aid = asn.analyst_id || asn.aid;
            var tid = asn.task_id;
            if (aid && tid) {
              var analyst = getAnalyst(aid);
              if (analyst) {
                await doAssign(tid, aid, 'AI_AUTO', asn);
                count++;
              }
            }
          }
        } else {
          console.warn('Batch '+(b+1)+' LLM call failed:', batchResp.status);
          llmFailed = true;
        }
      } catch(e) {
        console.warn('Batch '+(b+1)+' error:', e);
        llmFailed = true;
      }
    }
    if (count > 0) {
      _lastScoringEngine = 'n8n';
      notify('Bulk Assign Complete', count+' task'+(count!==1?'s':'')+' assigned via AI Agent ('+taskBatches.length+' LLM batch call'+(taskBatches.length>1?'s':'')+').'+(llmFailed?' Some batches failed.':''), 'success');
    } else {
      _lastScoringEngine = 'local';
      notify('n8n AI Agent Failed', 'LLM batch scoring returned no assignments. Check n8n configuration or turn off n8n toggle.', 'error');
    }
  } else {
    // n8n OFF: use local scoring fallback
    for (var k = 0; k < taskBatches.length; k++) {
      for (var m = 0; m < taskBatches[k].length; m++) {
        var item = taskBatches[k][m];
        var taskObj = TASKS.find(function(x){ return x.id === item.task_id; });
        if (taskObj) {
          var scored = localScoring(taskObj);
          if (scored.length) {
            await doAssign(item.task_id, scored[0].analyst_id, 'AI_AUTO', scored[0]);
            count++;
          }
        }
      }
    }
    _lastScoringEngine = 'local';
    notify('Bulk Assign Complete', count+' task'+(count!==1?'s':'')+' assigned via local AI scoring.', 'success');
  }
  renderTasks();
}

// ── Embedding Generation (async, fire-and-forget) ───────────────
function triggerEmbedding(taskId) {
  if (!CFG.useN8n || !N8N_EMBED_URL || N8N_EMBED_URL.length < 5) return;
  fetch(N8N_EMBED_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId })
  }).then(function(r){
    if (r.ok) console.log('Embedding queued for', taskId);
    else console.warn('Embedding trigger failed:', r.status);
  }).catch(function(e){ console.warn('Embedding trigger error:', e); });
}

// ── Create Task ─────────────────────────────────────────────────
async function createTask(aiAssign) {
  var desc = document.getElementById('ct-desc').value || 'New validation failure batch';
  var queueId = document.getElementById('ct-queue').value;
  var priority = document.getElementById('ct-priority').value;
  var domainId = document.getElementById('ct-domain').value;
  var slaInput = document.getElementById('ct-sla').value;
  var slaMap = {Critical:4,High:8,Medium:24,Low:48};
  var slaDeadline = slaInput ? new Date(slaInput).toISOString() : new Date(Date.now() + slaMap[priority]*3600000).toISOString();

  // Generate ref via Supabase function or fallback
  var ref = 'TSK-' + String(Date.now()).slice(-6);
  try {
    var refRes = await sb.rpc('generate_task_ref');
    if (refRes.data) ref = refRes.data;
  } catch(e) { console.warn('Ref gen fallback:', e); }

  var taskId = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
  var insertData = {
    id: taskId, ref: ref, description: desc, queue_id: queueId,
    priority: priority, status: 'New', domain_id: domainId,
    sla_deadline: slaDeadline, outcomes_count: 0, open_count: 0,
    created_at: new Date().toISOString()
  };

  var res = await sb.from('tasks').insert(insertData).select().single();
  if (res.error) { notify('Error', 'Task creation failed: '+res.error.message, 'error'); return; }

  var newTask = mapTask(res.data);
  TASKS.unshift(newTask);
  triggerEmbedding(taskId);
  closeModal('create-overlay');
  notify('Task Created', ref+' added to '+(QUEUES_MAP[queueId]||queueId)+' queue.', 'success');

  if (aiAssign || CFG.autoAssign) {
    setTimeout(async function(){
      var n8nMode = CFG.useN8n && N8N_ASSIGN_URL && N8N_ASSIGN_URL.length > 5;
      var sugs = await getAISuggestions(taskId);
      if (n8nMode && _lastScoringEngine !== 'n8n') {
        notify('n8n AI Agent Failed', ref+' created but could not auto-assign. n8n did not return suggestions. Assign manually or turn off n8n toggle.', 'error');
        return;
      }
      if (sugs && sugs.length) {
        var top = sugs[0];
        var a = getAnalyst(top.aid);
        if (a) await doAssign(taskId, top.aid, 'AI_AUTO', top);
      }
    }, 500);
  }
  renderTasks();
}

// ── Ingest Failed Outcomes ──────────────────────────────────────
function openIngestModal() {
  foRows = [{id:++foCounter, field:'ISIN', rule:'expect_column_values_to_not_be_null', severity:'Stop Field'}];
  renderFOList();
  openModal('ingest-overlay');
}
function syncFOFromDOM() {
  foRows.forEach(function(r){
    var fEl = document.getElementById('fo-field-'+r.id);
    var rEl = document.getElementById('fo-rule-'+r.id);
    var sEl = document.getElementById('fo-sev-'+r.id);
    if (fEl) r.field = fEl.value;
    if (rEl) r.rule = rEl.value;
    if (sEl) r.severity = sEl.value;
  });
}
function addFORow() {
  syncFOFromDOM();
  foRows.push({id:++foCounter, field:'ISIN', rule:'expect_column_values_to_not_be_null', severity:'Stop Field'});
  renderFOList();
}
function removeFORow(id) {
  syncFOFromDOM();
  foRows = foRows.filter(function(r){ return r.id !== id; });
  renderFOList();
}
function selAttr(current, val) { return current === val ? ' selected' : ''; }
function renderFOList() {
  var html = foRows.map(function(r, idx){
    return '<div class="fo-item"><span class="fo-item-idx">'+(idx+1)+'</span>'
      +'<select class="form-input" id="fo-field-'+r.id+'" style="font-size:12px;">'
        +'<option'+selAttr(r.field,'ISIN')+' value="ISIN">ISIN</option>'
        +'<option'+selAttr(r.field,'CFI Code')+' value="CFI Code">CFI Code</option>'
        +'<option'+selAttr(r.field,'Effective To/From')+' value="Effective To/From">Effective To/From</option>'
      +'</select>'
      +'<select class="form-input" id="fo-rule-'+r.id+'" style="font-size:12px;">'
        +'<option'+selAttr(r.rule,'expect_column_values_to_not_be_null')+' value="expect_column_values_to_not_be_null">Not Null</option>'
        +'<option'+selAttr(r.rule,'expect_column_values_to_match_regex')+' value="expect_column_values_to_match_regex">Match Regex</option>'
        +'<option'+selAttr(r.rule,'Effective To should be greater than Effective From')+' value="Effective To should be greater than Effective From">Date Range</option>'
      +'</select>'
      +'<select class="form-input" id="fo-sev-'+r.id+'" style="font-size:12px;">'
        +'<option'+selAttr(r.severity,'Stop Field')+' value="Stop Field">Stop Field</option>'
        +'<option'+selAttr(r.severity,'Warning')+' value="Warning">Warning</option>'
      +'</select>'
      +'<button class="fo-remove" onclick="removeFORow('+r.id+')">&#10005;</button></div>';
  }).join('');
  document.getElementById('fo-list').innerHTML = html || '<div class="empty-state" style="padding:16px;"><div class="empty-text">No records. Click "+ Add Record".</div></div>';
}

async function ingestAndCreate(aiAssign) {
  if (!foRows.length) { notify('No Records','Add at least one record.','warn'); return; }
  // Read actual form values
  foRows.forEach(function(r){
    var fEl = document.getElementById('fo-field-'+r.id);
    var rEl = document.getElementById('fo-rule-'+r.id);
    var sEl = document.getElementById('fo-sev-'+r.id);
    if (fEl) r.field = fEl.value;
    if (rEl) r.rule = rEl.value;
    if (sEl) r.severity = sEl.value;
  });

  var queueId = document.getElementById('ing-queue').value;
  var priority = document.getElementById('ing-priority').value;
  var domainId = document.getElementById('ing-domain').value;
  var desc = document.getElementById('ing-desc').value || (foRows.length+' failed outcomes - '+(QUEUES_MAP[queueId]||queueId)+' batch');
  var slaInput = document.getElementById('ing-sla').value;
  var slaMap = {Critical:4,High:8,Medium:24,Low:48};
  var slaDeadline = slaInput ? new Date(slaInput).toISOString() : new Date(Date.now()+slaMap[priority]*3600000).toISOString();

  var ref = 'TSK-' + String(Date.now()).slice(-6);
  try { var rr = await sb.rpc('generate_task_ref'); if(rr.data) ref = rr.data; } catch(e){}

  var taskId = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
  var taskData = {
    id: taskId, ref: ref, description: desc, queue_id: queueId,
    priority: priority, status: 'New', domain_id: domainId,
    sla_deadline: slaDeadline, field: foRows[0].field, rule: foRows[0].rule,
    outcomes_count: foRows.length, open_count: foRows.length,
    created_at: new Date().toISOString()
  };

  var tRes = await sb.from('tasks').insert(taskData).select().single();
  if (tRes.error) { notify('Error', 'Task creation failed: '+tRes.error.message, 'error'); return; }

  // Insert failed outcomes
  var foInserts = foRows.map(function(r){
    return {
      task_id: taskId,
      record_id: 'REC-' + Date.now() + '-' + r.id,
      validated_field: r.field,
      rule_description: r.rule,
      validation_stage: 'Normalized',
      table_name: QUEUES_MAP[queueId] || queueId,
      severity: r.severity,
      domain_id: domainId,
      status: 'In Task'
    };
  });
  var foRes = await sb.from('failed_outcomes').insert(foInserts);
  if (foRes.error) {
    console.error('Failed outcomes insert error:', foRes.error);
    notify('Warning', 'Task created but failed outcomes insert error: ' + foRes.error.message, 'warn');
  }

  var newTask = mapTask(tRes.data);
  TASKS.unshift(newTask);
  triggerEmbedding(taskId);
  closeModal('ingest-overlay');
  notify('Outcomes Ingested', ref+' created with '+foRows.length+' outcome(s).', 'success');

  if (aiAssign || CFG.autoAssign || CFG.ingestAuto) {
    setTimeout(async function(){
      var n8nMode = CFG.useN8n && N8N_ASSIGN_URL && N8N_ASSIGN_URL.length > 5;
      var sugs = await getAISuggestions(taskId);
      if (n8nMode && _lastScoringEngine !== 'n8n') {
        notify('n8n AI Agent Failed', ref+' created but could not auto-assign. n8n did not return suggestions. Assign manually or turn off n8n toggle.', 'error');
        return;
      }
      if (sugs && sugs.length) {
        var top = sugs[0];
        var a = getAnalyst(top.aid);
        if (a) await doAssign(taskId, top.aid, 'AI_AUTO', top);
      }
    }, 500);
  }
  renderTasks();
}

function openCreateTaskModal() { openModal('create-overlay'); }

// ── Render: SLA Monitor ─────────────────────────────────────────
function renderSLA() {
  var notDone = TASKS.filter(function(t){ return t.status!=='Resolved'&&t.status!=='Closed'; });
  var breached = notDone.filter(function(t){ return getSLA(t).cls==='sla-breached'; });
  var atRisk = notDone.filter(function(t){ return getSLA(t).cls==='sla-risk'; });
  var onTrack = notDone.filter(function(t){ return getSLA(t).cls==='sla-ok'; }).sort(function(a,b){return a.sla-b.sla;}).slice(0,6);

  var html = '<div class="stats-row" style="grid-template-columns:repeat(3,1fr);max-width:600px;margin-bottom:20px;">'
    +'<div class="stat-card c-breach"><div class="stat-label">SLA Breached</div><div class="stat-value">'+breached.length+'</div><div class="stat-sub">Immediate action</div></div>'
    +'<div class="stat-card c-risk"><div class="stat-label">At Risk (&lt;2h)</div><div class="stat-value">'+atRisk.length+'</div><div class="stat-sub">Monitor</div></div>'
    +'<div class="stat-card c-resolved"><div class="stat-label">On Track</div><div class="stat-value">'+onTrack.length+'</div><div class="stat-sub">Within SLA</div></div></div>';

  function slaGroup(title, tasks, cls) {
    if (!tasks.length) return '';
    var rows = tasks.map(function(t){
      var s = getSLA(t); var a = t.assignee?getAnalyst(t.assignee):null;
      return '<div class="sla-row" onclick="openTask(\''+t.id+'\')">'
        +'<div class="sla-priority-bar" style="background:'+priColor(t.priority)+'"></div>'
        +'<div class="sla-row-info"><div class="sla-row-ref">'+t.ref+'</div><div class="sla-row-desc">'+t.desc+'</div></div>'
        +'<span class="badge '+pClass(t.priority)+'">'+t.priority+'</span>'
        +'<span style="font-size:12px;color:var(--text3);">'+t.queue+'</span>'
        +(a?'<div class="assignee-wrap"><div class="av-chip" style="background:'+a.color+';width:22px;height:22px;font-size:9px;">'+a.initials+'</div><span style="font-size:12px;">'+a.name.split(' ')[0]+'</span></div>':'<span style="font-size:11px;color:var(--red);font-weight:600;">Unassigned</span>')
        +'<div class="sla-countdown '+cls+'">'+s.txt+'</div>'
        +(!t.assignee?'<button class="btn btn-ai btn-xs" onclick="event.stopPropagation();openAISuggest(\''+t.id+'\')">&#9889; Assign</button>':'')
        +'</div>';
    }).join('');
    return '<div class="sla-group"><div class="sla-group-hdr"><div class="sla-group-title">'+title+'</div><span class="badge '+(cls==='sla-breached'?'b-critical':cls==='sla-risk'?'b-high':'b-resolved')+'">'+tasks.length+'</span></div>'+rows+'</div>';
  }
  html += slaGroup('SLA Breached', breached, 'sla-breached');
  html += slaGroup('At Risk', atRisk, 'sla-risk');
  html += slaGroup('On Track', onTrack, 'sla-ok');
  document.getElementById('main-content').innerHTML = html;
}

// ── Render: Team ────────────────────────────────────────────────
function renderTeam() {
  var html = '<div class="analyst-grid">';
  ANALYSTS.forEach(function(a){
    var avToday = !isOnLeaveToday(a.id);
    var note = getLeaveNote(a.id);
    var wh = isInWorkingHours(a);
    var activeColor = a.active>=5?'var(--red)':a.active>=3?'var(--amber)':'var(--green)';
    var days5 = getNext5DaysAvail(a.id);
    var upcoming = getUpcomingLeaves(a.id);
    var tzLabel = formatTZ(a.tz);

    var tempUnavail = isTempUnavailable(a.id);
    var isAvail = avToday && !tempUnavail;
    var badgeLabel = tempUnavail ? 'Temp Away' : (avToday ? 'Available' : (note || 'On Leave'));
    var badgeCls = isAvail ? 'avail-yes' : (tempUnavail ? 'avail-temp' : 'avail-no');

    // ── Header: Avatar, Name, Email, Country, Availability badge ──
    html += '<div class="analyst-card">'
      +'<div class="analyst-hdr">'
      +'<div class="analyst-av" style="background:'+a.color+'">'+a.initials+'</div>'
      +'<div style="flex:1;min-width:0;">'
      +'<div class="analyst-name">'+a.name+'</div>'
      +'<div class="analyst-email">'+a.id+(a.country?' &middot; '+a.country:'')+'</div>'
      +'</div>'
      +'<div class="avail-badge '+badgeCls+'">'+badgeLabel+'</div>'
      +'</div>';

    // ── Info Rows: Domains + Queues ──
    html += '<div class="ac-info-rows">';
    if (a.domains && a.domains.length) {
      html += '<div class="ac-info-row"><span class="ac-info-lbl">Domains</span><span class="ac-info-val">'+a.domains.join(', ')+'</span></div>';
    }
    if (a.queues && a.queues.length) {
      html += '<div class="ac-info-row"><span class="ac-info-lbl">Queues</span><span class="ac-info-val">'+a.queues.join(', ')+'</span></div>';
    }
    html += '</div>';

    // ── Stats Row ──
    html += '<div class="analyst-stats">'
      +'<div class="a-stat"><div class="a-stat-val" style="color:'+activeColor+'">'+a.active+'</div><div class="a-stat-lbl">Active Tasks</div></div>'
      +'<div class="a-stat"><div class="a-stat-val">'+a.exp+' <small style="font-size:10px;font-weight:400;">yrs</small></div><div class="a-stat-lbl">Experience</div></div>'
      +'<div class="a-stat"><div class="a-stat-val" style="color:var(--blue)">'+(a.avg_resolution_mins||'N/A')+'</div><div class="a-stat-lbl">Avg Res (min)</div></div>'
      +'</div>';

    // ── Speciality chips ──
    if (a.skills && a.skills.length) {
      html += '<div class="ac-section"><span class="ac-section-lbl">Speciality</span>'
        +'<div class="skill-chips">'+a.skills.map(function(s){return '<span class="skill-chip">'+s+'</span>';}).join('')+'</div></div>';
    }

    // ── Working Hours ──
    html += '<div class="ac-section"><span class="ac-section-lbl">Working Hours</span>'
      +'<div class="ac-wh-row">'
      +'<span class="ac-wh-time">'+wh.label+'</span>'
      +(tzLabel?'<span class="ac-wh-tz">'+tzLabel+'</span>':'')
      +'<span class="ac-wh-status '+(wh.inHours?'in-hrs':'off-hrs')+'">'+(wh.label==='Not Set'?'':'&#9679; '+(wh.inHours?'In Hours':'Off Hours'))+'</span>'
      +'</div></div>';

    // ── 5-day Availability Strip ──
    html += '<div class="ac-section"><span class="ac-section-lbl">Availability (5 days)</span>'
      +'<div class="avail-strip">'+days5.map(function(d){
        return '<div class="avail-day"><div class="avail-day-lbl">'+d.label.slice(0,3)+'</div>'
          +'<div class="avail-dot '+(d.available?'yes':'no')+'"></div></div>';
      }).join('')+'</div></div>';

    // ── Temp Unavailability Note ──
    if (tempUnavail) {
      var tuNote = getTempUnavailNote(a.id);
      html += '<div class="ac-temp-away">'
        +'<span class="ac-temp-away-icon">&#9203;</span>'
        +'<span class="ac-temp-away-text">Temporarily Unavailable &mdash; '+(tuNote||'')+'</span>'
        +'<button class="ac-temp-away-clear" onclick="clearTempUnavail(\''+a.id+'\')">Clear</button>'
        +'</div>';
    }

    // ── Upcoming Leaves ──
    if (upcoming.length) {
      html += '<div class="ac-leaves">';
      upcoming.forEach(function(lv){
        var isCurrent = lv.date_from <= new Date().toISOString().split('T')[0];
        html += '<div class="ac-leave-row'+(isCurrent?' current':'')+'">'
          +'<span class="ac-leave-type">'+(lv.type||'Leave')+'</span>'
          +'<span class="ac-leave-dates">'+lv.date_from+' &rarr; '+lv.date_to+'</span>'
          +'<button class="ac-leave-del" onclick="deleteLeave('+lv.id+',\''+a.id+'\')" title="Delete leave">&#10005;</button>'
          +'</div>';
      });
      html += '</div>';
    }

    // ── Action Buttons ──
    html += '<div class="ac-actions">'
      +'<button class="ac-act-btn" onclick="openEditWorkingHrs(\''+a.id+'\')" title="Edit Working Hours">&#9203; Hours</button>'
      +'<button class="ac-act-btn" onclick="openAddLeave(\''+a.id+'\')" title="Add Leave">&#128197; Leave</button>'
      +'<button class="ac-act-btn" onclick="openManageAssignments(\''+a.id+'\')" title="Manage Queues &amp; Domains">&#9881; Queues/Domains</button>'
      +(tempUnavail
        ? '<button class="ac-act-btn ac-act-clear" onclick="clearTempUnavail(\''+a.id+'\')" title="Clear Unavailability">&#10003; Mark Available</button>'
        : '<button class="ac-act-btn ac-act-away" onclick="openTempUnavail(\''+a.id+'\')" title="Set Temporarily Unavailable">&#9888; Mark Away</button>')
      +'</div>';

    html += '</div>';
  });
  html += '</div>';
  document.getElementById('main-content').innerHTML = html;
}

// ── Analyst Management Modals ────────────────────────────────────

// --- Edit Working Hours ---
function openEditWorkingHrs(analystId) {
  var a = getAnalyst(analystId);
  if (!a) return;
  var fromVal = a.wh_from ? String(a.wh_from).slice(0,5) : '';
  var toVal = a.wh_to ? String(a.wh_to).slice(0,5) : '';
  var tzVal = a.tz || '';

  var tzOpts = ['','America/New_York','America/Chicago','America/Denver','America/Los_Angeles',
    'Europe/London','Europe/Paris','Europe/Berlin','Asia/Kolkata','Asia/Singapore','Asia/Tokyo',
    'Asia/Shanghai','Australia/Sydney','Pacific/Auckland'].map(function(tz){
    return '<option value="'+tz+'"'+(tz===tzVal?' selected':'')+'>'+( tz || '-- Select Timezone --')+'</option>';
  }).join('');

  var html = '<div class="modal-header"><div><div class="modal-title">&#9203; Edit Working Hours</div>'
    +'<div class="modal-subtitle">'+a.name+'</div></div>'
    +'<div class="modal-close" onclick="closeModal(\'analyst-overlay\')">&#10005;</div></div>'
    +'<div class="modal-body">'
    +'<div class="form-grid">'
    +'<div class="form-field"><label class="form-label">From</label><input type="time" class="form-input" id="am-wh-from" value="'+fromVal+'"/></div>'
    +'<div class="form-field"><label class="form-label">To</label><input type="time" class="form-input" id="am-wh-to" value="'+toVal+'"/></div>'
    +'</div>'
    +'<div class="form-field" style="margin-top:12px;"><label class="form-label">Timezone</label><select class="form-input" id="am-wh-tz">'+tzOpts+'</select></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-default" onclick="closeModal(\'analyst-overlay\')">Cancel</button>'
    +'<button class="btn btn-primary" onclick="saveWorkingHrs(\''+analystId+'\')">Save</button></div>';
  document.getElementById('analyst-modal-body').innerHTML = html;
  openModal('analyst-overlay');
}

async function saveWorkingHrs(analystId) {
  var from = document.getElementById('am-wh-from').value || null;
  var to = document.getElementById('am-wh-to').value || null;
  var tz = document.getElementById('am-wh-tz').value || null;

  var updateObj = { working_hrs_from: from, working_hrs_to: to, timezone: tz, updated_at: new Date().toISOString() };
  var res = await sb.from('analysts').update(updateObj).eq('id', analystId);
  if (res.error) { notify('Error', 'Failed to update working hours: ' + res.error.message, 'error'); return; }

  var a = getAnalyst(analystId);
  if (a) { a.wh_from = from; a.wh_to = to; a.tz = tz; a.working_hrs_from = from; a.working_hrs_to = to; a.timezone = tz; }
  notify('Updated', a ? a.name + ' working hours saved.' : 'Working hours saved.', 'success');
  closeModal('analyst-overlay');
  renderTeam();
}

// --- Add Leave ---
function openAddLeave(analystId) {
  var a = getAnalyst(analystId);
  if (!a) return;
  var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  var defFrom = new Date().toISOString().split('T')[0];
  var defTo = tomorrow.toISOString().split('T')[0];

  var html = '<div class="modal-header"><div><div class="modal-title">&#128197; Add Leave</div>'
    +'<div class="modal-subtitle">'+a.name+'</div></div>'
    +'<div class="modal-close" onclick="closeModal(\'analyst-overlay\')">&#10005;</div></div>'
    +'<div class="modal-body">'
    +'<div class="form-grid">'
    +'<div class="form-field"><label class="form-label">From Date *</label><input type="date" class="form-input" id="am-lv-from" value="'+defFrom+'"/></div>'
    +'<div class="form-field"><label class="form-label">To Date *</label><input type="date" class="form-input" id="am-lv-to" value="'+defTo+'"/></div>'
    +'</div>'
    +'<div class="form-field" style="margin-top:12px;"><label class="form-label">Leave Type</label>'
    +'<select class="form-input" id="am-lv-type"><option>Annual Leave</option><option>Sick Leave</option><option>Personal Leave</option><option>Public Holiday</option><option>Training</option><option>Other</option></select></div>'
    +'<div class="form-field" style="margin-top:12px;"><label class="form-label">Notes (optional)</label>'
    +'<input class="form-input" id="am-lv-notes" placeholder="e.g. family event, doctor appointment..."/></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-default" onclick="closeModal(\'analyst-overlay\')">Cancel</button>'
    +'<button class="btn btn-primary" onclick="saveLeave(\''+analystId+'\')">Add Leave</button></div>';
  document.getElementById('analyst-modal-body').innerHTML = html;
  openModal('analyst-overlay');
}

async function saveLeave(analystId) {
  var from = document.getElementById('am-lv-from').value;
  var to = document.getElementById('am-lv-to').value;
  var type = document.getElementById('am-lv-type').value;
  var notes = document.getElementById('am-lv-notes').value || '';
  if (!from || !to) { notify('Error', 'Both dates are required.', 'error'); return; }
  if (to < from) { notify('Error', 'To date must be after From date.', 'error'); return; }

  var insertObj = { analyst_id: analystId, date_from: from, date_to: to, type: type, notes: notes, approved: true };
  var res = await sb.from('analyst_leaves').insert(insertObj);
  if (res.error) { notify('Error', 'Failed to add leave: ' + res.error.message, 'error'); return; }

  await loadLeaves();
  var a = getAnalyst(analystId);
  notify('Leave Added', (a ? a.name : analystId) + ' — ' + type + ' (' + from + ' to ' + to + ')', 'success');
  closeModal('analyst-overlay');
  renderTeam();
}

async function deleteLeave(leaveId, analystId) {
  if (!confirm('Delete this leave entry?')) return;
  var res = await sb.from('analyst_leaves').delete().eq('id', leaveId);
  if (res.error) { notify('Error', 'Failed to delete leave: ' + res.error.message, 'error'); return; }
  await loadLeaves();
  notify('Leave Deleted', 'Leave entry removed.', 'success');
  renderTeam();
}

// --- Manage Queues & Domains ---
function openManageAssignments(analystId) {
  var a = getAnalyst(analystId);
  if (!a) return;

  var queueCheckboxes = QUEUES_LIST.map(function(q){
    var checked = a.queue_ids_raw.indexOf(q.id) > -1;
    return '<label class="am-cb-label"><input type="checkbox" class="am-q-cb" value="'+q.id+'"'+(checked?' checked':'')+'/> '+q.name+'</label>';
  }).join('');

  var domainCheckboxes = DOMAINS_LIST.map(function(d){
    var checked = a.domain_ids_raw.indexOf(d.id) > -1;
    return '<label class="am-cb-label"><input type="checkbox" class="am-d-cb" value="'+d.id+'"'+(checked?' checked':'')+'/> '+d.name+'</label>';
  }).join('');

  var html = '<div class="modal-header"><div><div class="modal-title">&#9881; Manage Queues &amp; Domains</div>'
    +'<div class="modal-subtitle">'+a.name+'</div></div>'
    +'<div class="modal-close" onclick="closeModal(\'analyst-overlay\')">&#10005;</div></div>'
    +'<div class="modal-body">'
    +'<div class="am-section"><div class="am-section-title">Queues</div>'
    +'<div class="am-cb-grid">'+queueCheckboxes+'</div></div>'
    +'<div class="am-section" style="margin-top:16px;"><div class="am-section-title">Domains</div>'
    +'<div class="am-cb-grid">'+domainCheckboxes+'</div></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-default" onclick="closeModal(\'analyst-overlay\')">Cancel</button>'
    +'<button class="btn btn-primary" onclick="saveAssignments(\''+analystId+'\')">Save</button></div>';
  document.getElementById('analyst-modal-body').innerHTML = html;
  openModal('analyst-overlay');
}

async function saveAssignments(analystId) {
  var queueIds = [];
  document.querySelectorAll('.am-q-cb:checked').forEach(function(cb){ queueIds.push(cb.value); });
  var domainIds = [];
  document.querySelectorAll('.am-d-cb:checked').forEach(function(cb){ domainIds.push(cb.value); });

  var res = await sb.from('analysts').update({
    queue_ids: queueIds, domain_ids: domainIds, updated_at: new Date().toISOString()
  }).eq('id', analystId);
  if (res.error) { notify('Error', 'Failed to update: ' + res.error.message, 'error'); return; }

  var a = getAnalyst(analystId);
  if (a) {
    a.queue_ids_raw = queueIds;
    a.domain_ids_raw = domainIds;
    a.queues = queueIds.map(function(qid){ return QUEUES_MAP[qid] || qid; });
    a.domains = domainIds.map(function(did){ return DOMAINS_MAP[did] || did; });
  }
  notify('Updated', (a ? a.name : analystId) + ' queues & domains updated.', 'success');
  closeModal('analyst-overlay');
  renderTeam();
}

// --- Temporary Unavailability ---
function openTempUnavail(analystId) {
  var a = getAnalyst(analystId);
  if (!a) return;

  // Default: 2 hours from now
  var def = new Date(Date.now() + 2*3600000);
  var defStr = def.toISOString().slice(0,16);

  var html = '<div class="modal-header"><div><div class="modal-title">&#9888; Set Temporarily Unavailable</div>'
    +'<div class="modal-subtitle">'+a.name+'</div></div>'
    +'<div class="modal-close" onclick="closeModal(\'analyst-overlay\')">&#10005;</div></div>'
    +'<div class="modal-body">'
    +'<p style="font-size:13px;color:var(--text2);margin:0 0 16px;">Set a time when this analyst will become available again. They will be marked as <strong>temporarily away</strong> until then. After the scheduled time, they automatically return to their normal working hours status.</p>'
    +'<div class="am-quick-btns">'
    +'<button class="btn btn-default btn-sm" onclick="setQuickUnavail(30)">30 min</button>'
    +'<button class="btn btn-default btn-sm" onclick="setQuickUnavail(60)">1 hour</button>'
    +'<button class="btn btn-default btn-sm" onclick="setQuickUnavail(120)">2 hours</button>'
    +'<button class="btn btn-default btn-sm" onclick="setQuickUnavail(240)">4 hours</button>'
    +'<button class="btn btn-default btn-sm" onclick="setQuickUnavailEOD()">End of day</button>'
    +'</div>'
    +'<div class="form-field" style="margin-top:14px;"><label class="form-label">Or pick a custom date &amp; time</label>'
    +'<input type="datetime-local" class="form-input" id="am-tu-until" value="'+defStr+'"/></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-default" onclick="closeModal(\'analyst-overlay\')">Cancel</button>'
    +'<button class="btn btn-primary" onclick="saveTempUnavail(\''+analystId+'\')">Mark Unavailable</button></div>';
  document.getElementById('analyst-modal-body').innerHTML = html;
  openModal('analyst-overlay');
}

function setQuickUnavail(mins) {
  var d = new Date(Date.now() + mins * 60000);
  document.getElementById('am-tu-until').value = d.toISOString().slice(0,16);
}
function setQuickUnavailEOD() {
  var d = new Date();
  d.setHours(23, 59, 0, 0);
  document.getElementById('am-tu-until').value = d.toISOString().slice(0,16);
}

async function saveTempUnavail(analystId) {
  var until = document.getElementById('am-tu-until').value;
  if (!until) { notify('Error', 'Please select a date and time.', 'error'); return; }
  var untilDate = new Date(until);
  if (untilDate <= new Date()) { notify('Error', 'Time must be in the future.', 'error'); return; }

  var res = await sb.from('analysts').update({
    temp_unavailable_until: untilDate.toISOString(), updated_at: new Date().toISOString()
  }).eq('id', analystId);
  if (res.error) { notify('Error', 'Failed to set unavailability: ' + res.error.message, 'error'); return; }

  var a = getAnalyst(analystId);
  if (a) a.temp_unavail = untilDate;
  notify('Marked Away', (a ? a.name : analystId) + ' is temporarily unavailable until ' + untilDate.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + '.', 'info');
  closeModal('analyst-overlay');
  renderTeam();
}

async function clearTempUnavail(analystId) {
  var res = await sb.from('analysts').update({
    temp_unavailable_until: null, updated_at: new Date().toISOString()
  }).eq('id', analystId);
  if (res.error) { notify('Error', 'Failed to clear unavailability: ' + res.error.message, 'error'); return; }

  var a = getAnalyst(analystId);
  if (a) a.temp_unavail = null;
  notify('Available', (a ? a.name : analystId) + ' is now available again.', 'success');
  renderTeam();
}

// ── Agentic Chatbot ──────────────────────────────────────────────
var chatHistory = [];

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
  document.getElementById('chat-unread').style.display = chatOpen ? 'none' : 'flex';
}

function chatSuggest(txt) { document.getElementById('chat-input').value = txt; sendChat(); }

async function sendChat() {
  var input = document.getElementById('chat-input');
  var msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  appendChatMsg(msg, 'user');
  chatHistory.push({ role: 'user', content: msg });
  appendTyping();

  var reply;
  // Try n8n AI Agent first (agentic — it has tools to query Supabase)
  if (CFG.useN8n && N8N_CHAT_URL && N8N_CHAT_URL.length > 5) {
    try {
      var resp = await fetch(N8N_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history: chatHistory.slice(-10) })
      });
      if (resp.ok) {
        var chatRaw = await resp.text();
        var chatCleaned = chatRaw.trim();
        if (chatCleaned.indexOf('```') > -1) chatCleaned = chatCleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        var chatData;
        try { chatData = JSON.parse(chatCleaned); } catch(ep) { chatData = chatCleaned; }
        reply = typeof chatData === 'string' ? chatData : (chatData.output || chatData.text || chatData.message || chatData.reply || JSON.stringify(chatData));
      }
    } catch(e) {
      console.warn('n8n Chat Agent unavailable, using local intelligence:', e);
    }
  }

  // Fallback: rich local data-driven answers
  if (!reply) reply = await localChatReply(msg);

  removeTyping();
  appendChatMsg(reply, 'ai');
  chatHistory.push({ role: 'assistant', content: reply });
}

function appendChatMsg(txt, role) {
  var c = document.getElementById('chat-msgs');
  var d = document.createElement('div');
  d.className = 'chat-msg' + (role==='user'?' user':'');
  d.innerHTML = '<div class="chat-av '+(role==='ai'?'ai':'usr')+'">'+(role==='ai'?'&#9889;':'U')+'</div><div class="chat-bubble">'+txt+'</div>';
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}
function appendTyping() {
  var c = document.getElementById('chat-msgs');
  var d = document.createElement('div'); d.className='chat-msg'; d.id='typing-ind';
  d.innerHTML = '<div class="chat-av ai">&#9889;</div><div class="chat-bubble"><div class="chat-typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}
function removeTyping() { var e = document.getElementById('typing-ind'); if (e) e.remove(); }

async function localChatReply(msg) {
  var lo = msg.toLowerCase();
  var now = new Date();
  var today = now.toISOString().split('T')[0];
  var activeTasks = TASKS.filter(function(t){ return t.status!=='Resolved'&&t.status!=='Closed'; });

  // ── SLA Breaches (today / yesterday / general) ──
  if (lo.includes('breach') || lo.includes('sla')) {
    var checkYesterday = lo.includes('yesterday');
    var breached = [];
    if (checkYesterday) {
      var yest = new Date(now); yest.setDate(yest.getDate()-1);
      var yestStr = yest.toISOString().split('T')[0];
      breached = TASKS.filter(function(t){
        return t.sla && t.sla.toISOString().split('T')[0] === yestStr && t.status!=='Resolved'&&t.status!=='Closed';
      });
      if (!breached.length) return '&#9989; No SLA breaches yesterday.';
      return '<strong>'+breached.length+' SLA breach(es) yesterday:</strong><br>'+breached.map(function(t){ var a=t.assignee?getAnalyst(t.assignee):null; return '&#9888; <strong>'+t.ref+'</strong> ('+t.priority+') &mdash; '+(a?a.name:'<span style="color:var(--red)">Unassigned</span>')+' &mdash; '+getSLA(t).txt; }).join('<br>');
    }
    breached = activeTasks.filter(function(t){ return getSLA(t).cls==='sla-breached'; });
    var atRisk = activeTasks.filter(function(t){ return getSLA(t).cls==='sla-at-risk'; });
    if (!breached.length && !atRisk.length) return '&#9989; No SLA breaches or at-risk tasks right now.';
    var html = '';
    if (breached.length) {
      html += '<strong style="color:var(--red);">&#9888; '+breached.length+' Breached:</strong><br>'+breached.map(function(t){ var a=t.assignee?getAnalyst(t.assignee):null; return '&bull; <strong>'+t.ref+'</strong> ('+t.priority+') &mdash; '+(a?a.name:'Unassigned')+' &mdash; '+getSLA(t).txt; }).join('<br>');
    }
    if (atRisk.length) {
      html += (breached.length?'<br><br>':'')+'<strong style="color:var(--amber);">&#9888; '+atRisk.length+' At Risk:</strong><br>'+atRisk.map(function(t){ var a=t.assignee?getAnalyst(t.assignee):null; return '&bull; <strong>'+t.ref+'</strong> ('+t.priority+') &mdash; '+(a?a.name:'Unassigned')+' &mdash; '+getSLA(t).txt; }).join('<br>');
    }
    return html;
  }

  // ── Unassigned Tasks ──
  if (lo.includes('unassign')) {
    var unassigned = activeTasks.filter(function(t){ return !t.assignee; });
    if (!unassigned.length) return '&#9989; All active tasks are assigned!';
    var todayOnly = lo.includes('today');
    if (todayOnly) {
      unassigned = unassigned.filter(function(t){ return t.created && t.created.toISOString().split('T')[0] === today; });
      if (!unassigned.length) return '&#9989; No unassigned tasks created today.';
    }
    var byQueue = {};
    unassigned.forEach(function(t){ var q = t.queue || 'Unknown'; if (!byQueue[q]) byQueue[q]=[]; byQueue[q].push(t); });
    var html = '<strong>'+unassigned.length+' Unassigned Task'+(unassigned.length!==1?'s':'')+(todayOnly?' (today)':'')+':</strong><br>';
    Object.keys(byQueue).forEach(function(q){
      html += '<br><strong>'+q+' ('+byQueue[q].length+'):</strong><br>';
      byQueue[q].forEach(function(t){ html += '&bull; <strong>'+t.ref+'</strong> &mdash; '+t.field+' &mdash; '+t.priority+' &mdash; '+getSLA(t).txt+'<br>'; });
    });
    html += '<br><em>Tip: Click "AI Auto-Assign All" to assign these automatically.</em>';
    return html;
  }

  // ── Team Availability (optionally filtered by queue) ──
  if (lo.includes('availab') || lo.includes('team') || lo.includes('who is')) {
    var queueFilter = null;
    QUEUES_LIST.forEach(function(q){
      if (lo.includes(q.name.toLowerCase())) queueFilter = q;
    });
    var analysts = ANALYSTS;
    if (queueFilter) {
      analysts = analysts.filter(function(a){ return a.queue_ids_raw && a.queue_ids_raw.indexOf(queueFilter.id) > -1; });
    }
    var available = [], unavailable = [];
    analysts.forEach(function(a){
      if (isOnLeaveToday(a.id)) unavailable.push(a); else available.push(a);
    });
    var html = '<strong>Team Availability'+(queueFilter?' — '+queueFilter.name+' Queue':'')+':</strong><br><br>';
    html += '<strong style="color:var(--green);">Available ('+available.length+'):</strong><br>';
    available.forEach(function(a){ html += '&#9679; <strong>'+a.name+'</strong> &mdash; '+a.active+' active tasks &mdash; '+a.queues.join(', ')+'<br>'; });
    if (unavailable.length) {
      html += '<br><strong style="color:var(--red);">Unavailable ('+unavailable.length+'):</strong><br>';
      unavailable.forEach(function(a){ html += '&#9675; <strong>'+a.name+'</strong> &mdash; '+(getLeaveNote(a.id)||'On Leave')+'<br>'; });
    }
    return html;
  }

  // ── Upcoming Leaves ──
  if (lo.includes('leave') || lo.includes('upcoming') || lo.includes('vacation') || lo.includes('pto')) {
    var upcoming = LEAVES.filter(function(l){ return l.date_from >= today || l.date_to >= today; })
      .sort(function(a,b){ return a.date_from < b.date_from ? -1 : 1; });
    if (!upcoming.length) return '&#9989; No upcoming leaves scheduled.';
    var html = '<strong>Upcoming Leaves ('+upcoming.length+'):</strong><br>';
    upcoming.forEach(function(l){
      var a = getAnalyst(l.analyst_id);
      var name = a ? a.name : l.analyst_id;
      var from = l.date_from, to = l.date_to;
      var isCurrent = l.date_from <= today && l.date_to >= today;
      html += (isCurrent?'&#9888;':'&#128197;')+' <strong>'+name+'</strong> &mdash; '+from+' to '+to+' ('+l.type+')' + (isCurrent?' <em style="color:var(--red);">&lt; Currently on leave</em>':'')+'<br>';
    });
    return html;
  }

  // ── Workload ──
  if (lo.includes('workload') || lo.includes('capacity') || lo.includes('how busy')) {
    var sorted = ANALYSTS.slice().sort(function(a,b){ return b.active - a.active; });
    var html = '<strong>Team Workload:</strong><br>';
    sorted.forEach(function(a){
      var bar = a.active >= 5 ? '&#128308;' : a.active >= 3 ? '&#128992;' : '&#128994;';
      html += bar+' <strong>'+a.name+'</strong>: '+a.active+' active task'+(a.active!==1?'s':'');
      if (a.avg_resolution_mins) html += ' (avg '+a.avg_resolution_mins+' min/task)';
      html += '<br>';
    });
    return html;
  }

  // ── Task Summary / Stats ──
  if (lo.includes('summary') || lo.includes('overview') || lo.includes('stats') || lo.includes('dashboard')) {
    var byStatus = {};
    TASKS.forEach(function(t){ byStatus[t.status] = (byStatus[t.status]||0)+1; });
    var byPriority = {};
    activeTasks.forEach(function(t){ byPriority[t.priority] = (byPriority[t.priority]||0)+1; });
    var unassigned = activeTasks.filter(function(t){ return !t.assignee; }).length;
    var breached = activeTasks.filter(function(t){ return getSLA(t).cls==='sla-breached'; }).length;
    var html = '<strong>&#128202; Operations Summary:</strong><br><br>';
    html += '<strong>By Status:</strong><br>';
    Object.keys(byStatus).forEach(function(s){ html += '&bull; '+s+': <strong>'+byStatus[s]+'</strong><br>'; });
    html += '<br><strong>Active Tasks by Priority:</strong><br>';
    Object.keys(byPriority).forEach(function(p){ html += '&bull; '+p+': <strong>'+byPriority[p]+'</strong><br>'; });
    html += '<br>&#9888; Unassigned: <strong>'+unassigned+'</strong>';
    html += '<br>&#128308; SLA Breached: <strong>'+breached+'</strong>';
    html += '<br>&#128101; Team Size: <strong>'+ANALYSTS.length+'</strong>';
    return html;
  }

  // ── Queue-specific queries ──
  var matchedQueue = null;
  QUEUES_LIST.forEach(function(q){ if (lo.includes(q.name.toLowerCase())) matchedQueue = q; });
  if (matchedQueue) {
    var qTasks = activeTasks.filter(function(t){ return t.queue_id_raw === matchedQueue.id; });
    var qAnalysts = ANALYSTS.filter(function(a){ return a.queue_ids_raw && a.queue_ids_raw.indexOf(matchedQueue.id) > -1; });
    var html = '<strong>'+matchedQueue.name+' Queue:</strong><br>';
    html += '&bull; Active Tasks: <strong>'+qTasks.length+'</strong><br>';
    html += '&bull; Unassigned: <strong>'+qTasks.filter(function(t){return !t.assignee;}).length+'</strong><br>';
    html += '&bull; SLA Breached: <strong>'+qTasks.filter(function(t){return getSLA(t).cls==='sla-breached';}).length+'</strong><br>';
    html += '&bull; Assigned Analysts: <strong>'+qAnalysts.length+'</strong><br>';
    qAnalysts.forEach(function(a){
      var avail = !isOnLeaveToday(a.id);
      html += '&nbsp;&nbsp;'+(avail?'&#9679;':'&#9675;')+' '+a.name+' ('+a.active+' tasks)'+(avail?'':' — On Leave')+'<br>';
    });
    return html;
  }

  // ── Help / Default ──
  return '<strong>&#9889; AI Operations Assistant</strong><br><br>I can answer questions about:<br>'
    +'&bull; <strong>SLA breaches</strong> — "SLA breaches today", "SLA at risk"<br>'
    +'&bull; <strong>Unassigned tasks</strong> — "Unassigned tasks", "Unassigned today"<br>'
    +'&bull; <strong>Team availability</strong> — "Who is available?", "Availability in Instruments queue"<br>'
    +'&bull; <strong>Upcoming leaves</strong> — "Upcoming leaves", "Who is on PTO?"<br>'
    +'&bull; <strong>Workload</strong> — "Team workload", "How busy is the team?"<br>'
    +'&bull; <strong>Queue details</strong> — "Instruments queue", "Funds queue status"<br>'
    +'&bull; <strong>Summary</strong> — "Dashboard summary", "Operations overview"<br>'
    +'<br><em>When connected to n8n AI Agent, I can answer any free-form question using live data.</em>';
}

// ── INIT ────────────────────────────────────────────────────────
async function init() {
  try {
    document.getElementById('loading-overlay').querySelector('.loading-text').textContent = 'Loading queues & domains...';
    await loadQueuesAndDomains();
    document.getElementById('loading-overlay').querySelector('.loading-text').textContent = 'Loading analysts...';
    await loadAnalysts();
    document.getElementById('loading-overlay').querySelector('.loading-text').textContent = 'Loading leaves...';
    await loadLeaves();
    document.getElementById('loading-overlay').querySelector('.loading-text').textContent = 'Loading tasks...';
    await loadTasks();
    await loadConfig();
    populateDropdowns();
    setupRealtime();
    renderTasks();
    updateBadges();
    document.getElementById('loading-overlay').style.display = 'none';
    console.log('LSEG Data Ops Hub initialized. Analysts:', ANALYSTS.length, 'Tasks:', TASKS.length, 'Queues:', QUEUES_LIST.length);
  } catch(e) {
    console.error('Init failed:', e);
    document.getElementById('loading-overlay').querySelector('.loading-text').innerHTML = '<span style="color:#d13438;">Connection failed. Check Supabase URL & Key in lseg-app.js</span><br><span style="font-size:12px;color:#666;">Error: '+e.message+'</span>';
  }
}

init();
