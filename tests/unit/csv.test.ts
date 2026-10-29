import { describe, expect, it } from 'vitest';
import {
  REQUIRED_COLUMNS,
  checkColumns,
  parseAppointments,
  parseCsv,
  parseOpenings,
  parseWaitlist,
} from '@/lib/csv';

const WAITLIST = [
  'line,added,name,phone,notes',
  '1,Jul 6,Gisele Maillet,506-555-0101,"90 - any - sciatica, L side"',
  '',
  '2,7/14,Pauline Bastarache,506 555 0102,any - 1hr - AM',
  '7,Aug 11,Lynn S.,same #,again - 45 or 60',
].join('\n');

const OPENINGS = [
  'opening_id,appointment_id,date,day,start,length_min,therapist,kind,cancelled_at,hours_notice,heard_via,client_had_confirmed,refilled,refilled_how,booked_value_cad',
  'O01,A-24010,2026-09-21,Mon,12:30,60,Josée Landry,late cancel,2026-09-21 09:47,2.7,phone,yes (text),no,,115',
  'O02,A-24020,2026-09-21,Mon,15:45,60,Amira Haddad,no-show,2026-09-21 16:00,0.0,no-show,no,no,,115',
].join('\n');

const APPOINTMENTS = [
  'appointment_id,date,start,end,length_min,service,therapist,client_id,client_name,booked_at,booked_via,confirmation,status,cancelled_at,cancel_via,late_fee,rebooked_into,desk_notes',
  'A-24100,2026-09-24,13:30,14:30,60,Massage therapy 60 min,Dave Melanson,K-2291,Melanie Arsenault,2026-09-24 09:09,desk,n/a (same day),Completed,,,,,filled from waitlist',
].join('\n');

describe('parseCsv', () => {
  it('reads a header row, skips empty lines and keeps values as written', () => {
    const rows = parseCsv(WAITLIST);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      line: '1',
      added: 'Jul 6',
      name: 'Gisele Maillet',
      phone: '506-555-0101',
      notes: '90 - any - sciatica, L side',
    });
    expect(rows[2]!.phone).toBe('same #');
  });

  it('trims header names', () => {
    const rows = parseCsv(' line , added \n1,Jul 6');
    expect(rows[0]).toEqual({ line: '1', added: 'Jul 6' });
  });

  it('handles Windows line endings and a BOM', () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n');
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('checkColumns', () => {
  it('passes with all columns', () => {
    expect(checkColumns(WAITLIST, 'waitlist')).toEqual({ ok: true, missing: [], rows: 3 });
    expect(checkColumns(OPENINGS, 'openings')).toEqual({ ok: true, missing: [], rows: 2 });
    expect(checkColumns(APPOINTMENTS, 'appointments')).toEqual({ ok: true, missing: [], rows: 1 });
  });

  it('lists the missing columns', () => {
    const res = checkColumns('line,name\n1,Ann', 'waitlist');
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['added', 'phone', 'notes']);
    expect(res.rows).toBe(1);
  });

  it('knows the answer key columns', () => {
    expect(REQUIRED_COLUMNS.answerKey).toEqual(['id', 'type', 'answer', 'marked_by', 'note']);
    expect(checkColumns('id,type,answer,marked_by,note\nO01,opening,none,x,y', 'answerKey').ok).toBe(true);
  });

  it('reports a header-only file as zero rows', () => {
    expect(checkColumns('line,added,name,phone,notes\n', 'waitlist')).toEqual({ ok: true, missing: [], rows: 0 });
  });
});

describe('parseWaitlist', () => {
  it('normalises lines', () => {
    const lines = parseWaitlist(WAITLIST, 2026);
    expect(lines.map((l) => l.id)).toEqual(['W01', 'W02', 'W07']);
    expect(lines[0]).toMatchObject({
      n: 1,
      added: 'Jul 6',
      date: '2026-07-06',
      name: 'Gisele Maillet',
      phone: '506-555-0101',
      phoneDigits: '5065550101',
    });
    expect(lines[1]!.date).toBe('2026-07-14');
    expect(lines[2]).toMatchObject({ phone: 'same #', phoneDigits: null });
  });

  it('throws a clear error naming the missing columns', () => {
    expect(() => parseWaitlist('line,name\n1,Ann', 2026)).toThrow(/missing column\(s\): added, phone, notes/);
    expect(() => parseOpenings('opening_id,date\nO1,2026-09-21')).toThrow(/appointment_id/);
    expect(() => parseAppointments('appointment_id\nA1')).toThrow(/client_name/);
  });
});

describe('parseOpenings', () => {
  it('converts numbers and types kind and therapist', () => {
    const [o1, o2] = parseOpenings(OPENINGS);
    expect(o1).toMatchObject({
      opening_id: 'O01',
      day: 'Mon',
      start: '12:30',
      length_min: 60,
      hours_notice: 2.7,
      therapist: 'Josée Landry',
      kind: 'late cancel',
      refilled_how: '',
    });
    expect(o2).toMatchObject({ kind: 'no-show', hours_notice: 0 });
  });

  it('rejects an unknown therapist or kind', () => {
    expect(() => parseOpenings(OPENINGS.replace('Josée Landry', 'Nobody Here'))).toThrow(/unknown therapist/);
    expect(() => parseOpenings(OPENINGS.replace('late cancel', 'whim'))).toThrow(/unknown kind/);
  });
});

describe('parseAppointments', () => {
  it('keeps every field as a string', () => {
    const [a] = parseAppointments(APPOINTMENTS);
    expect(a).toMatchObject({
      appointment_id: 'A-24100',
      client_name: 'Melanie Arsenault',
      booked_at: '2026-09-24 09:09',
      status: 'Completed',
      length_min: '60',
      cancelled_at: '',
    });
  });
});
