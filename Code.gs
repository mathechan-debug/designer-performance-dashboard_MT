// ============================================================
//  HomeLane Designer Performance Dashboard — Code.gs
//
//  DEPLOYMENT: Execute as Me · Anyone in homelane.com
//
//  Access sheet: EMAIL | ROLE | SHOWROOMS
//    Designer → own rows only   (SHOWROOMS blank)
//    DM/BM/GM/BUH → by SHOWROOM (comma-separated)
//    Admin → all rows           (SHOWROOMS blank)
// ============================================================

var CONFIG = {
  SPREADSHEET_ID: '',        // Paste your Google Sheet ID here
  DATA_SHEET:     'Sheet1',
  ACCESS_SHEET:   'Access',
  AUDIT_SHEET:    'AuditLog',
  CACHE_TTL:      900,       // 15 min — all roles including Admin
  CACHE_CHUNK:    90000,     // 90 KB per shard (GAS limit is 100 KB)
};

// ── Summary column filter ─────────────────────────────────────
// Initial load for non-designer roles returns only these columns
// (~60% smaller payload). Full data fetched on demand per designer.
var SUMMARY_NORM = [
  'designername','designeremail','jobrole',
  'month','showroom','city','cluster',
  'custmeetings','qualifiedmeetings',
  'oborders','obvalue','obat10',
  'r2p',
  'p2porders','r2porders','p2porder','r2porder',
  'prismagraduate','prismgraduate','announcedin','coursename',
  'panindarank','panindirank','clusterrank',
  'r2pbenchmark',
];

function normCol_(s) { return s.toLowerCase().replace(/[\s_\-]/g, ''); }

function filterToSummaryCols_(rows) {
  if (!rows || !rows.length) return rows;
  var keep = Object.keys(rows[0]).filter(function(k) {
    return SUMMARY_NORM.indexOf(normCol_(k)) >= 0;
  });
  return rows.map(function(row) {
    var out = {};
    keep.forEach(function(k) { out[k] = row[k]; });
    return out;
  });
}

// ── Chunked cache helpers ─────────────────────────────────────
// CacheService silently drops values > 100 KB — split into shards.
function cachePut(cache, key, data) {
  try {
    var json = JSON.stringify(data);
    var n    = Math.ceil(json.length / CONFIG.CACHE_CHUNK);
    cache.put(key + '__n', String(n), CONFIG.CACHE_TTL);
    for (var i = 0; i < n; i++) {
      cache.put(
        key + '__' + i,
        json.slice(i * CONFIG.CACHE_CHUNK, (i + 1) * CONFIG.CACHE_CHUNK),
        CONFIG.CACHE_TTL
      );
    }
  } catch (e) { Logger.log('cachePut: ' + e.message); }
}

function cacheGet(cache, key) {
  try {
    var nStr = cache.get(key + '__n');
    if (!nStr) return null;
    var n = parseInt(nStr, 10);
    var parts = [];
    for (var i = 0; i < n; i++) {
      var chunk = cache.get(key + '__' + i);
      if (!chunk) return null;
      parts.push(chunk);
    }
    return JSON.parse(parts.join(''));
  } catch (e) { return null; }
}

// ── Serve HTML ────────────────────────────────────────────────
function doGet(e) {
  return HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('Designer Performance Dashboard | HomeLane')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ── Initial load ──────────────────────────────────────────────
function getInitialData() {
  var ss = openSheet_();
  if (!ss) return { error: 'Cannot open spreadsheet.' };

  var email = getEmail_();
  if (!email) return { error: 'Could not detect your Google account. Sign in first.' };

  var access = getUserAccess(email, ss);
  var data   = getDataForRole(email, access, ss);

  if (!data)        return { error: 'Could not read data sheet.' };
  if (!data.length) return { error: 'No records found for ' + email + '. Check sheet or contact admin.' };

  logAccess(email, access.role, access.scope.join(','), 'SUCCESS', ss);
  return { success: true, email: email, role: access.role, scope: access.scope, data: data };
}

// ── On-demand full data for one designer ─────────────────────
function getDesignerFullData(designerEmail) {
  var ss = openSheet_();
  if (!ss) return { error: 'Cannot open spreadsheet.' };

  var reqEmail = getEmail_();
  if (!reqEmail) return { error: 'Not authenticated.' };

  var access     = getUserAccess(reqEmail, ss);
  var role       = access.role.toLowerCase().trim();
  var isDesigner = isDesignerRole_(role);
  if (isDesigner && designerEmail.toLowerCase() !== reqEmail) return { error: 'Access denied.' };

  designerEmail = designerEmail.trim().toLowerCase();

  var cache    = CacheService.getScriptCache();
  var cacheKey = 'des_' + designerEmail.replace(/[^a-z0-9]/g, '_');
  var cached   = cacheGet(cache, cacheKey);
  if (cached) return { success: true, data: cached };

  var sheet = findDataSheet_(ss);
  if (!sheet) return { error: 'Data sheet not found.' };

  var all     = sheet.getDataRange().getValues();
  if (all.length < 2) return { data: [] };

  var headers  = all[0].map(function(h) { return h ? h.toString().trim().toUpperCase() : ''; });
  var emailCol = headers.indexOf('DESIGNER_EMAIL');
  var filtered = all.slice(1).filter(function(row) {
    return emailCol >= 0 && row[emailCol].toString().trim().toLowerCase() === designerEmail;
  });

  var result = formatRows(headers, filtered, Session.getScriptTimeZone());
  cachePut(cache, cacheKey, result);
  return { success: true, data: result };
}

// ── Role-based data fetch ─────────────────────────────────────
function getDataForRole(email, access, ss) {
  try {
    var role       = access.role.toLowerCase().trim();
    var isDesigner = isDesignerRole_(role);

    var cache    = CacheService.getScriptCache();
    var cacheKey = 'r3_' + email.replace(/[^a-z0-9]/g, '_') + '_' + role.replace(/\s/g, '_');
    var cached   = cacheGet(cache, cacheKey);
    if (cached) return cached;

    var sheet = findDataSheet_(ss);
    if (!sheet) return null;

    var all  = sheet.getDataRange().getValues();
    if (all.length < 2) return [];

    var headers     = all[0].map(function(h) { return h ? h.toString().trim().toUpperCase() : ''; });
    var emailCol    = headers.indexOf('DESIGNER_EMAIL');
    var showroomCol = headers.indexOf('SHOWROOM');

    var filtered = all.slice(1).filter(function(row) {
      var blank = true;
      for (var ci = 0; ci < row.length; ci++) {
        if (row[ci] !== '' && row[ci] != null) { blank = false; break; }
      }
      if (blank) return false;

      if (isAdminRole_(role)) return true;
      if (isDesigner) return emailCol >= 0 && row[emailCol].toString().trim().toLowerCase() === email;

      if (showroomCol < 0 || !access.scope.length) return false;
      var sr = row[showroomCol].toString().trim().toLowerCase();
      return access.scope.some(function(s) { return sr === s.toLowerCase(); });
    });

    var result = formatRows(headers, filtered, Session.getScriptTimeZone());

    // Non-designer roles: trim to summary columns → smaller payload
    if (!isDesigner) result = filterToSummaryCols_(result);

    cachePut(cache, cacheKey, result);
    return result;
  } catch (e) {
    Logger.log('getDataForRole: ' + e.message);
    return null;
  }
}

// ── Access sheet lookup ───────────────────────────────────────
function getUserAccess(email, ss) {
  var def = { role: 'Designer', scope: [] };
  try {
    var sheet = ss.getSheetByName(CONFIG.ACCESS_SHEET);
    if (!sheet) return def;
    var rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return def;

    var hdr  = rows[0].map(function(h) { return h.toString().trim().toUpperCase(); });
    var eCol = hdr.indexOf('EMAIL');
    var rCol = hdr.indexOf('ROLE');
    var sCol = ['SHOWROOMS','SHOWROOM','SCOPE'].reduce(function(a, k) {
      return a >= 0 ? a : hdr.indexOf(k);
    }, -1);
    if (eCol < 0 || rCol < 0) return def;

    for (var i = 1; i < rows.length; i++) {
      if (!rows[i][eCol]) continue;
      if (rows[i][eCol].toString().trim().toLowerCase() === email) {
        return {
          role:  rows[i][rCol].toString().trim() || 'Designer',
          scope: sCol >= 0 && rows[i][sCol]
            ? rows[i][sCol].toString().split(',').map(function(s) { return s.trim(); }).filter(Boolean)
            : [],
        };
      }
    }
  } catch (e) { Logger.log('getUserAccess: ' + e.message); }
  return def;
}

// ── Format date cells → readable strings ─────────────────────
function formatRows(headers, rows, tz) {
  var MON  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var mIdx = headers.indexOf('MONTH');
  var dIdx = headers.indexOf('DESIGNERS_DOJ');

  return rows.map(function(row) {
    var obj = {};
    for (var i = 0; i < headers.length; i++) {
      var v = row[i];
      if (v instanceof Date) {
        if      (i === mIdx) v = MON[v.getMonth()] + ' ' + v.getFullYear();
        else if (i === dIdx) v = Utilities.formatDate(v, tz, 'dd MMM yyyy');
        else                 v = Utilities.formatDate(v, tz, 'MMM yyyy');
      }
      obj[headers[i]] = (v != null) ? v : '';
    }
    return obj;
  });
}

// ── Audit log ─────────────────────────────────────────────────
function logAccess(email, role, scope, status, ss) {
  try {
    var log = ss.getSheetByName(CONFIG.AUDIT_SHEET);
    if (!log) {
      log = ss.insertSheet(CONFIG.AUDIT_SHEET);
      log.appendRow(['Timestamp','Email','Role','Scope','Status','SessionID']);
      log.getRange(1,1,1,6).setFontWeight('bold');
    }
    var tz = Session.getScriptTimeZone();
    log.appendRow([
      Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss'),
      email, role, scope, status, Utilities.getUuid().slice(0,8)
    ]);
  } catch (e) { Logger.log('logAccess: ' + e.message); }
}

// ── Helpers ───────────────────────────────────────────────────
function isDesignerRole_(role) {
  return ['designer','design consultant','dc','sdc','pdc','spdc',
          'design associate','da'].indexOf(role) >= 0;
}
function isAdminRole_(role) {
  return ['admin','administrator'].indexOf(role) >= 0;
}
function openSheet_() {
  try { return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); } catch(e) { return null; }
}
function getEmail_() {
  try {
    var e = Session.getActiveUser().getEmail();
    return e ? e.trim().toLowerCase() : '';
  } catch(_) { return ''; }
}
function findDataSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (sheet) return sheet;
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var n = sheets[i].getName();
    if (n !== CONFIG.ACCESS_SHEET && n !== CONFIG.AUDIT_SHEET) {
      Logger.log('DATA_SHEET "' + CONFIG.DATA_SHEET + '" not found — using "' + n + '"');
      return sheets[i];
    }
  }
  return null;
}
function getCurrentUserEmail() { return getEmail_(); }

// ── Run once after deploy to flush stale cache ────────────────
function clearAllCache() {
  CacheService.getScriptCache().removeAll([]);
  Logger.log('Cache cleared.');
}
