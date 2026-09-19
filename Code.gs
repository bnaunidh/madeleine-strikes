/**
 * THE DATABASE — The Madeleine Dashboard
 * Paste this into a new Google Sheet: Extensions → Apps Script.
 * Then Deploy → New deployment → Web app.  Execute as: Me.  Who has access: Anyone.
 * Copy the /exec link into the app's Code Center.
 *
 * It does two jobs: it keeps her devices in step, and it writes the whole thing
 * out as a spreadsheet she can read.
 */
var DB_VERSION = "1.0.0";
var DEFAULT_CODE = "5643";
var MAX_EVENTS = 400;      // returned to a device in one sync
var BLOB_MAX = 45000;      // a cell holds 50k characters
var LOCK_MS = 25000;

var H_ROSTER = ["Student","Class","Strikes now","Strikes this year","Hits now","Hits this year",
                "Last strike","Last strike — reason","Last hit","Last hit — reason","Test student","Updated"];
var W_ROSTER = [180,70,95,125,80,110,150,175,150,160,95,150];
var H_EVENTS = ["When","Date","Time","Weekday","Student","Class","Type","Reason","Category","Count after","Device","Event ID"];
var W_EVENTS = [150,95,75,95,180,70,70,190,130,105,110,180];
var H_LOGINS = ["When","Device","Login ID"];
var W_LOGINS = [160,140,200];

/* =========================== web app entry points =========================== */

/**
 * The app POSTs with Content-Type: text/plain on purpose.
 * text/plain is one of the three CORS-safelisted content types, so the browser sends
 * NO preflight OPTIONS — which matters because an Apps Script web app has no doOptions
 * and cannot answer one. The body is still JSON; we parse it ourselves.
 */
function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || "{}"); }
  catch (err) { return json_({ ok: false, error: "That sync message wasn't readable." }); }
  return json_(handle_(body));
}

/** Opening the /exec link in a browser gives a friendly page, so she can check it works. */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.p) {                                   // JSONP fallback for locked-down networks
    var out;
    try { out = handle_(JSON.parse(p.p)); }
    catch (err) { out = { ok: false, error: String(err) }; }
    return ContentService
      .createTextOutput((p.callback || "__dbcb") + "(" + JSON.stringify(out) + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return HtmlService.createHtmlOutput(
    '<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:36px;max-width:520px;margin:auto">' +
    '<h2 style="margin:0 0 6px">The Database is running</h2>' +
    '<p style="color:#666">Version ' + DB_VERSION + '. This is the right link — copy it into the ' +
    'Code Center in The Madeleine Dashboard.</p></div>');
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ================================ the work ================================= */

function handle_(b) {
  if (!b || b.v !== 1) return { ok: false, error: "This sheet expects a newer or older app." };
  var code = String(b.code || "").trim();
  if (!/^\d{3,12}$/.test(code)) return { ok: false, error: "Missing class code." };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(LOCK_MS); }
  catch (err) { return { ok: false, error: "The Database was busy. It will try again." }; }

  try {
    var store = readStore_(code);
    var merged = merge_(store, b);
    writeStore_(code, merged);
    compile_(code, merged);                    // <- the spreadsheet she actually reads
    return {
      ok: true,
      epoch: merged.epoch,
      gone: merged.gone,
      students: merged.students,
      events: merged.events.slice(-MAX_EVENTS),
      logins: merged.logins.slice(0, 25),
      settings: merged.settings,
      settingsTs: merged.settingsTs
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/** Same rule as the app: most marks wins, and a newer reset wins outright. */
function merge_(store, b) {
  var epoch = Math.max(Number(b.epoch) || 0, Number(store.epoch) || 0);

  // tombstones: a removal travels to every device, and survives here so a device
  // that has been offline for a week cannot push the student back.
  var gone = {};
  (store.gone || []).forEach(function (t) { if (t && t.key) gone[t.key] = Math.max(gone[t.key] || 0, Number(t.ts) || 0); });
  (b.gone || []).forEach(function (t) { if (t && t.key) gone[t.key] = Math.max(gone[t.key] || 0, Number(t.ts) || 0); });
  var goneList = Object.keys(gone).map(function (k) { return { key: k, ts: gone[k] }; })
    .sort(function (x, y) { return y.ts - x.ts; }).slice(0, 500);
  var buried = function (key, addedTs) { return gone[key] != null && gone[key] >= (Number(addedTs) || 0); };

  var byKey = {};
  (store.students || []).forEach(function (s) { if (!buried(s.key, s.addedTs)) byKey[s.key] = s; });

  (b.students || []).forEach(function (r) {
    if (!r || !r.key || !r.name) return;
    if (buried(r.key, r.addedTs)) return;
    var s = byKey[r.key];
    if (!s) { s = { key: r.key, name: r.name, cls: r.cls || "", strikes: 0, total: 0, hits: 0, hitTotal: 0, done: {}, rdone: {}, test: false, addedTs: Number(r.addedTs) || 0, ep: 0 }; byKey[r.key] = s; }
    // the epoch is per student now, so a reset of one class cannot outrank another
    var rE = Number(r.ep) || Number(b.epoch) || 0, lE = Number(s.ep) || 0;
    var pick = function (mine, theirs) {
      if (rE > lE) return theirs;
      if (rE < lE) return mine;
      return Math.max(mine, theirs);
    };
    s.name = r.name; s.cls = r.cls || "";
    s.strikes  = pick(Number(s.strikes) || 0,  Number(r.strikes) || 0);
    s.hits     = pick(Number(s.hits) || 0,     Number(r.hits) || 0);
    s.total    = pick(Number(s.total) || 0,    Number(r.total) || 0);      // a newer year-reset wins
    s.hitTotal = pick(Number(s.hitTotal) || 0, Number(r.hitTotal) || 0);
    s.ep = Math.max(rE, lE);
    s.test = !!r.test;
    if (r.done)  Object.keys(r.done).forEach(function (k) { if (r.done[k]) { s.done = s.done || {}; s.done[k] = true; } });
    if (r.rdone) Object.keys(r.rdone).forEach(function (k) { if (r.rdone[k]) { s.rdone = s.rdone || {}; s.rdone[k] = true; } });
    if (r.lastStrike && r.lastStrike.when) s.lastStrike = r.lastStrike;
    if (r.lastHit && r.lastHit.when) s.lastHit = r.lastHit;
    s.updated = new Date().toISOString();
  });

  var students = Object.keys(byKey).map(function (k) { return byKey[k]; });

  // events: append-only, deduped on a stable id
  var seen = {};
  var events = (store.events || []).filter(function (ev) {
    if (!ev || !ev.eid || seen[ev.eid]) return false; seen[ev.eid] = 1; return true;
  });
  var fresh = [];
  (b.events || []).forEach(function (ev) {
    if (!ev || !ev.eid || seen[ev.eid]) return;
    seen[ev.eid] = 1;
    ev.device = b.deviceName || b.device || "";
    fresh.push(ev);
  });
  events = events.concat(fresh).sort(function (x, y) { return (x.ts || 0) - (y.ts || 0); });

  var seenL = {};
  var logins = (store.logins || []).concat(b.logins || []).filter(function (l) {
    if (!l || !l.id || seenL[l.id]) return false; seenL[l.id] = 1; return true;
  }).sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); }).slice(0, 50);

  var settings = store.settings || {}, settingsTs = Number(store.settingsTs) || 0;
  if (b.settings && (Number(b.settingsTs) || 0) > settingsTs) { settings = b.settings; settingsTs = Number(b.settingsTs) || 0; }

  return { epoch: epoch, gone: goneList, students: students, events: events, logins: logins,
           settings: settings, settingsTs: settingsTs, newEvents: fresh };
}

/* ============================== the spreadsheet ============================== */

function compile_(code, m) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sfx = (code === DEFAULT_CODE) ? "" : " " + code;

  // ---- Roster: everyone, their strikes and hits, and their most recent one ----
  var roster = tab_(ss, "Roster" + sfx, H_ROSTER, W_ROSTER);
  var rows = m.students.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
    .map(function (s) {
      return [s.name, s.cls || "", s.strikes || 0, s.total || 0, s.hits || 0, s.hitTotal || 0,
              (s.lastStrike && s.lastStrike.when) || "", (s.lastStrike && s.lastStrike.reason) || "",
              (s.lastHit && s.lastHit.when) || "", (s.lastHit && s.lastHit.reason) || "",
              s.test ? "yes" : "", s.updated || ""];
    });
  var last = roster.getLastRow();
  if (last > 1) roster.getRange(2, 1, last - 1, H_ROSTER.length).clearContent();
  if (rows.length) roster.getRange(2, 1, rows.length, H_ROSTER.length).setValues(rows);

  // ---- Events: append only the new ones, so this stays cheap all year ----
  if (m.newEvents && m.newEvents.length) {
    var ev = tab_(ss, "Events" + sfx, H_EVENTS, W_EVENTS);
    var out = m.newEvents.map(function (e) {
      var d = new Date(Number(e.ts) || 0);
      return [fmt_(d), fmtDate_(d), fmtTime_(d), dayName_(d), e.name || "", e.cls || "",
              e.t === "hit" ? "Hit" : "Strike", e.reason || "", e.category || "",
              Number(e.count) || "", e.device || "", e.eid];
    });
    ev.getRange(ev.getLastRow() + 1, 1, out.length, H_EVENTS.length).setValues(out);
  }

  // ---- Logins ----
  var lg = tab_(ss, "Logins" + sfx, H_LOGINS, W_LOGINS);
  var lrows = (m.logins || []).map(function (l) { return [fmt_(new Date(Number(l.ts) || 0)), l.device || "", l.id]; });
  var ll = lg.getLastRow();
  if (ll > 1) lg.getRange(2, 1, ll - 1, H_LOGINS.length).clearContent();
  if (lrows.length) lg.getRange(2, 1, lrows.length, H_LOGINS.length).setValues(lrows);

  summary_(ss, sfx);
  syncTab_(ss, sfx, m);
}

/** Written once as live formulas, so it keeps working as Events grows. */
function summary_(ss, sfx) {
  var name = "Summary" + sfx, sh = ss.getSheetByName(name);
  if (sh) return;                                    // never rewrite it — she may have added her own
  sh = ss.insertSheet(name);
  var E = "'Events" + sfx + "'";
  sh.getRange("A1").setValue("The Madeleine Dashboard — Summary").setFontWeight("bold").setFontSize(14);
  sh.getRange("A3").setValue("Total strikes").setFontWeight("bold");
  sh.getRange("B3").setFormula('=COUNTIF(' + E + '!G:G,"Strike")');
  sh.getRange("A4").setValue("Total hits").setFontWeight("bold");
  sh.getRange("B4").setFormula('=COUNTIF(' + E + '!G:G,"Hit")');
  sh.getRange("A6").setValue("By student").setFontWeight("bold");
  sh.getRange("A7").setFormula('=QUERY(' + E + '!E:G,"select E, count(G) where E is not null group by E order by count(G) desc label count(G) \'Marks\'",1)');
  sh.getRange("D6").setValue("By reason").setFontWeight("bold");
  sh.getRange("D7").setFormula('=QUERY(' + E + '!H:H,"select H, count(H) where H is not null group by H order by count(H) desc label count(H) \'Times\'",1)');
  sh.getRange("G6").setValue("By category").setFontWeight("bold");
  sh.getRange("G7").setFormula('=QUERY(' + E + '!I:I,"select I, count(I) where I is not null group by I order by count(I) desc label count(I) \'Times\'",1)');
  sh.getRange("J6").setValue("By weekday").setFontWeight("bold");
  sh.getRange("J7").setFormula('=QUERY(' + E + '!D:D,"select D, count(D) where D is not null group by D order by count(D) desc label count(D) \'Times\'",1)');
  sh.setColumnWidths(1, 12, 130);
  sh.setFrozenRows(2);
}

/** The machine tab. Hidden, and it says so in words in case she finds it. */
function syncTab_(ss, sfx, m) {
  var sh = ss.getSheetByName("Sync" + sfx) || ss.insertSheet("Sync" + sfx);
  sh.getRange("A1").setValue("This tab is how the app talks to itself. Please don't edit it.");
  sh.getRange("A2").setValue("Last sync");
  sh.getRange("B2").setValue(fmt_(new Date()));
  try { sh.hideSheet(); } catch (e) {}
}

/* ================================= helpers ================================= */

/** Found by id, so renaming a tab doesn't break it; rebuilt with headers if deleted. */
function tab_(ss, name, headers, widths) {
  var props = PropertiesService.getDocumentProperties();
  var key = "tab:" + name, id = props.getProperty(key), sh = null;
  if (id) {
    var all = ss.getSheets();
    for (var i = 0; i < all.length; i++) if (String(all[i].getSheetId()) === id) { sh = all[i]; break; }
  }
  if (!sh) sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  props.setProperty(key, String(sh.getSheetId()));

  var head = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var needs = false;
  for (var j = 0; j < headers.length; j++) if (head[j] !== headers[j]) needs = true;
  if (needs) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
    for (var k = 0; k < widths.length; k++) sh.setColumnWidth(k + 1, widths[k]);
  }
  return sh;
}

function readStore_(code) {
  var props = PropertiesService.getDocumentProperties();
  var raw = props.getProperty("store:" + code);
  if (!raw) {
    var n = Number(props.getProperty("chunks:" + code) || 0), parts = [];
    for (var i = 0; i < n; i++) parts.push(props.getProperty("store:" + code + ":" + i) || "");
    raw = parts.join("");
  }
  if (!raw) return { epoch: 0, gone: [], students: [], events: [], logins: [], settings: {}, settingsTs: 0 };
  try { return JSON.parse(raw); }
  catch (e) { return { epoch: 0, gone: [], students: [], events: [], logins: [], settings: {}, settingsTs: 0 }; }
}

function writeStore_(code, m) {
  var keep = { epoch: m.epoch, gone: m.gone, students: m.students, events: m.events.slice(-2000),
               logins: m.logins, settings: stripHeavy_(m.settings), settingsTs: m.settingsTs };
  var raw = JSON.stringify(keep);
  var props = PropertiesService.getDocumentProperties();
  var old = Number(props.getProperty("chunks:" + code) || 0);
  for (var i = 0; i < old; i++) props.deleteProperty("store:" + code + ":" + i);
  if (raw.length <= BLOB_MAX) { props.setProperty("store:" + code, raw); props.setProperty("chunks:" + code, "0"); return; }
  props.deleteProperty("store:" + code);
  var n = Math.ceil(raw.length / BLOB_MAX);
  for (var j = 0; j < n; j++) props.setProperty("store:" + code + ":" + j, raw.substr(j * BLOB_MAX, BLOB_MAX));
  props.setProperty("chunks:" + code, String(n));
}

/** Uploaded sound files are base64 data URIs — they'd blow past the cell limit. */
function stripHeavy_(s) {
  if (!s) return {};
  var out = {};
  Object.keys(s).forEach(function (k) {
    if (k === "soundAdd" || k === "soundRemove") return;
    if (typeof s[k] === "string" && s[k].length > 4000) return;
    out[k] = s[k];
  });
  return out;
}

function tz_() { return Session.getScriptTimeZone() || "America/Los_Angeles"; }
function fmt_(d)     { return Utilities.formatDate(d, tz_(), "yyyy-MM-dd HH:mm"); }
function fmtDate_(d) { return Utilities.formatDate(d, tz_(), "yyyy-MM-dd"); }
function fmtTime_(d) { return Utilities.formatDate(d, tz_(), "HH:mm"); }
function dayName_(d) { return Utilities.formatDate(d, tz_(), "EEEE"); }
