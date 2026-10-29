// Throwaway check: do the rules in rules.md reproduce Tanya's answer key?
// Readings (Step 1) are hand-encoded from the notes, standing in for Claude.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const RUN = '2026-10-21';

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [h, ...rest] = rows.filter(r => r.length > 1);
  return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const read = f => parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'));
const wl = read('waitlist-2026-10-21.csv');
const ops = read('late-openings-2026-09-21-to-2026-10-17.csv');
const appts = read('appointments-2026-09-21-to-2026-10-17.csv');
const key = read('answer-key-tanya.csv');

const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12 };
function lineDate(s) {
  let m, d;
  if (/^\d+\/\d+$/.test(s)) [m, d] = s.split('/').map(Number);
  else { const [a, b] = s.split(' '); m = MON[a]; d = Number(b); }
  return `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const digits = p => p.replace(/\D/g, '');

// ---- Step 1: group lines into people ----
const lines = wl.map(r => ({ id: `W${String(r.line).padStart(2, '0')}`, n: Number(r.line), date: lineDate(r.added), name: r.name, phone: r.phone, notes: r.notes }));
const groups = [];
for (const l of lines) {
  let g = null;
  if (l.phone.toLowerCase() === 'same #') {
    const first = l.name.split(' ')[0].toLowerCase();
    const initial = (l.name.split(' ')[1] || '').replace('.', '').toLowerCase();
    g = [...groups].reverse().find(g => g.some(x => x.name.split(' ')[0].toLowerCase() === first && (x.name.split(' ')[1] || '').toLowerCase().startsWith(initial)));
  } else g = groups.find(g => g.some(x => x.phone.toLowerCase() !== 'same #' && digits(x.phone) === digits(l.phone)));
  if (g) g.push(l); else groups.push([l]);
}

// ---- Step 2: tags (stale) — readings of "gone" and "end date" stand in for Claude ----
const gone = new Set(['W23', 'W29', 'W50']);              // moved / going elsewhere / not in service
const endDate = { W11: '2026-09-30', W32: '2026-10-10', W17: '2026-10-03', W34: '2026-10-03' };
const NICK = { mel: 'melanie', jen: 'jennifer', bob: 'robert', steph: 'stephanie' };
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fullName = n => { const [f, ...r] = norm(n).split(' '); return [NICK[f] || f, ...r].join(' '); };
const cutoff = '2026-08-21'; // two calendar months before Oct 21

const verdict = {}; const people = [];
for (const g of groups) {
  const newest = g[g.length - 1];
  const names = new Set(g.map(x => fullName(x.name)).filter(n => n.split(' ')[1]?.length > 2));
  const reasons = [];
  if (newest.date < cutoff) reasons.push('two months');
  if (g.some(x => gone.has(x.id))) reasons.push('gone');
  if (g.some(x => endDate[x.id] && endDate[x.id] < RUN)) reasons.push('end date');
  const bk = appts.find(a => names.has(fullName(a.client_name)) && a.booked_at.slice(0, 10) > newest.date && a.booked_at.slice(0, 10) <= RUN && a.status !== 'Cancelled');
  if (bk) reasons.push(`booked ${bk.booked_at.slice(0, 10)}`);
  for (const x of g) verdict[x.id] = reasons.length ? 'stale' : x === newest ? 'active' : `duplicate of ${newest.id}`;
  if (!reasons.length) people.push({ id: newest.id, n: newest.n, name: g.reduce((a, x) => x.name.length > a.length ? x.name : a, ''), reasons });
}

// ---- Step 1 readings for active people (what B5/Claude must produce) ----
const FEM = ['Josée Landry', 'Amira Haddad', 'Kelsey Babineau', 'Rachel Thibodeau'];
const T = { J: 'Josée Landry', A: 'Amira Haddad', K: 'Kelsey Babineau', R: 'Rachel Thibodeau', D: 'Dave Melanson', M: 'Marc Cormier' };
const ALL = Object.values(T);
const t = s => s.split('').map(c => T[c]);
const WK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const P = {
  W10: { ther: t('AK'), len: [60], days: WK },
  W12: { ther: ALL.filter(x => x !== T.D), len: [60], notDays: ['Thu'], after: '15:30' },
  W14: { ther: t('J'), len: [45, 60], notice: 3 },
  W18: { ther: t('M'), len: [60], before: '12:00', notice: 0.5 },
  W20: { ther: FEM, len: [60], days: ['Tue', 'Thu'] },
  W24: { ther: ALL, len: [60], after: '17:00' },
  W28: { ther: ALL, len: [90], only: true, days: ['Sat'] },
  W33: { ther: ALL.filter(x => x !== T.D), len: [60], notDays: ['Mon'], before: '12:00' },
  W36: { ther: t('A'), len: [45], after: '10:00' },
  W37: { ther: ALL, len: [60], days: ['Fri'], after: '15:00' },
  W38: { ther: t('R'), len: [60], after: '18:00' },
  W39: { ther: ALL, len: [30, 45], days: WK, after: '12:00', startBy: '12:30', notice: 0.5 },
  W40: { ther: t('AK'), len: [60], notice: 3 },
  W42: { ther: t('RJ'), len: [60] },
  W43: { ther: t('KA'), len: [60], endBy: '14:30' },
  W45: { ther: t('JA'), len: [60], notDays: ['Fri'] },
  W46: { ther: t('MD'), len: [60] },
  W47: { ther: t('D'), len: [60, 90], after: '16:00' },
  W48: { ther: t('JR'), len: [60], before: '12:00' },
  W49: { ther: FEM, len: [45], days: ['Wed', 'Fri'], notice: 4 },
  W51: { ther: ALL, len: [60], days: ['Mon', 'Wed'], before: '12:00' },
  W52: { ther: t('KJ'), len: [60], days: ['Wed', 'Fri'] },
  W53: { ther: ALL, len: [60, 90], notDays: ['Sat'], from: '2026-10-10' },
  W54: { ther: ALL.filter(x => x !== T.D), len: [90], only: true, after: '16:00' },
  W55: { ther: t('RA'), len: [60], nextDay: true },
  W56: { ther: t('A'), len: [60], days: ['Mon', 'Tue'] },
  W57: { ther: t('DJ'), len: [60], after: '12:00', notice: 2 },
  W58: { ther: t('D'), len: [90], only: true, days: ['Tue', 'Fri'] },
  W59: { ther: ALL, len: [45], days: ['Mon', 'Tue'], after: '17:00', notice: 1 },
  W60: { ther: ALL, len: [60], notDays: ['Thu'], before: '12:00' },
};
const PREGNANT = new Set(['W10', 'W40']);

// ---- Step 3: every check must pass. Step 4: waitlist order (newest line), first 3 ----
const mins = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function fits(p, o) {
  const r = P[p.id]; if (!r) return false;
  if (!r.ther.includes(o.therapist)) return false;
  if (PREGNANT.has(p.id) && ![T.A, T.K].includes(o.therapist)) return false;
  const L = Number(o.length_min);
  if (r.only ? !r.len.includes(L) : L < Math.min(...r.len)) return false;
  if (r.days && !r.days.includes(o.day)) return false;
  if (r.notDays && r.notDays.includes(o.day)) return false;
  const s = mins(o.start);
  if (r.after && s < mins(r.after)) return false;
  if (r.before && s >= mins(r.before)) return false;
  if (r.startBy && s > mins(r.startBy)) return false;
  if (r.endBy && s + L > mins(r.endBy)) return false;
  if (Number(o.hours_notice) < (r.notice ?? 2)) return false;
  if (r.nextDay && o.cancelled_at.slice(0, 10) >= o.date) return false;
  if (r.from && o.date < r.from) return false;
  return true;
}

const keyOf = Object.fromEntries(key.map(k => [k.id, k.answer]));
let lineOk = 0; const lineBad = [];
for (const l of lines) (verdict[l.id] === keyOf[l.id] ? lineOk++ : lineBad.push(`${l.id}: ours=${verdict[l.id]} key=${keyOf[l.id]}`));

let fullOk = 0, top3Ok = 0, fridayOk = 0; const opBad = [];
for (const o of ops) {
  const list = o.kind === 'no-show' ? [] : people.filter(p => fits(p, o)).sort((a, b) => a.n - b.n).map(p => p.id);
  const keyIds = keyOf[o.opening_id] === 'none' ? [] : keyOf[o.opening_id].split('; ').map(s => s.split(' ')[0]);
  const shown = list.slice(0, 3);
  if (list.join() === keyIds.join()) fullOk++; else opBad.push(`${o.opening_id}: ours=${list.join(' ') || 'none'} key=${keyIds.join(' ') || 'none'}`);
  if (shown.join() === keyIds.slice(0, 3).join()) top3Ok++;
  if (shown.length ? shown.every(x => keyIds.includes(x)) : keyIds.length === 0) fridayOk++;
}
console.log(`Line verdicts: ${lineOk}/${lines.length}`); lineBad.forEach(x => console.log('  ' + x));
console.log(`Openings, full list and order: ${fullOk}/${ops.length}`); opBad.forEach(x => console.log('  ' + x));
console.log(`Openings, first 3 equal key's first 3: ${top3Ok}/${ops.length}`);
console.log(`Openings, Friday rule (every name shown is on key's list; nobody = nobody): ${fridayOk}/${ops.length}`);
