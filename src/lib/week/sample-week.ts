// A made-up week (Mon Oct 12 to Sat Oct 17, 2026) for the Week schedule screen (build-plan Screen 4).
// SIMULATED DATA ONLY: the screen is an interactive mockup (BUILD_PROGRESS assumption A5). It never reads the
// booking export, the store or Kneadly. Thursday is exactly the 25 rows of reference/mockups/A4-Week-schedule.dc.html.
// rules.md "Always": plain first and last names only, no notes, no reasons for visit, no health details.

export type WeekStatus = 'Completed' | 'Refilled' | 'Late cancel' | 'No-show' | 'Cancelled';

export interface WeekRow {
  /** YYYY-MM-DD */
  day: string;
  therapist: string;
  /** 24-hour "HH:MM" */
  start: string;
  end: string;
  client: string;
  status: WeekStatus;
}

export const WEEK_TITLE = 'Week of Oct 12, 2026';
export const DEFAULT_DAY = '2026-10-15';

/** The clinic's six therapists in the fixed column order. */
export const THERAPISTS = [
  'Amira Haddad',
  'Dave Melanson',
  'Josée Landry',
  'Kelsey Babineau',
  'Marc Cormier',
  'Rachel Thibodeau',
] as const;

export const WEEK_DAYS: readonly { iso: string; tab: string }[] = [
  { iso: '2026-10-12', tab: 'Mon, Oct 12' },
  { iso: '2026-10-13', tab: 'Tue, Oct 13' },
  { iso: '2026-10-14', tab: 'Wed, Oct 14' },
  { iso: '2026-10-15', tab: 'Thu, Oct 15' },
  { iso: '2026-10-16', tab: 'Fri, Oct 16' },
  { iso: '2026-10-17', tab: 'Sat, Oct 17' },
];

type Tuple = [string, string, string, string, WeekStatus];
const rowsFor = (day: string, tuples: Tuple[]): WeekRow[] =>
  tuples.map(([therapist, start, end, client, status]) => ({ day, therapist, start, end, client, status }));

const MON = rowsFor('2026-10-12', [
  ['Amira Haddad', '09:00', '10:00', 'Nathalie Gauthier', 'Completed'],
  ['Amira Haddad', '10:15', '11:15', 'Philippe Arsenault', 'Completed'],
  ['Amira Haddad', '11:30', '12:30', 'Lise Doucet', 'Late cancel'],
  ['Amira Haddad', '13:00', '14:00', 'Gilles Savoie', 'Refilled'],
  ['Amira Haddad', '14:15', '15:15', 'Monique Richard', 'Completed'],
  ['Amira Haddad', '16:00', '17:00', 'Brian Cormier', 'Completed'],
  ['Dave Melanson', '09:30', '10:30', 'Andrea Poirier', 'Completed'],
  ['Dave Melanson', '11:00', '12:00', 'Luc Mallet', 'No-show'],
  ['Dave Melanson', '12:30', '14:00', 'Sandra Hébert', 'Completed'],
  ['Dave Melanson', '14:30', '15:30', 'Patrick Leger', 'Cancelled'],
  ['Dave Melanson', '16:00', '17:00', 'Nicole Robichaud', 'Completed'],
  ['Dave Melanson', '17:30', '18:30', 'Ryan Cyr', 'Completed'],
  ['Josée Landry', '09:00', '09:45', 'Chantal Comeau', 'Completed'],
  ['Josée Landry', '10:00', '11:00', 'Mario Basque', 'Completed'],
  ['Josée Landry', '11:15', '12:00', 'Annie LeBlanc', 'Refilled'],
  ['Josée Landry', '13:00', '14:00', 'Denis Thériault', 'Completed'],
  ['Josée Landry', '15:00', '16:00', 'Julie Gallant', 'Late cancel'],
  ['Josée Landry', '16:15', '17:15', 'Kevin Babin', 'Completed'],
  ['Josée Landry', '18:00', '19:00', 'Isabelle Roy', 'Completed'],
  ['Kelsey Babineau', '10:00', '11:00', 'Tara Mazerolle', 'Completed'],
  ['Kelsey Babineau', '11:30', '12:30', 'Wayne Hache', 'Cancelled'],
  ['Kelsey Babineau', '13:00', '14:00', 'Colette Doiron', 'Completed'],
  ['Kelsey Babineau', '14:30', '15:30', 'Stéphane Pitre', 'Completed'],
  ['Kelsey Babineau', '16:00', '17:30', 'Heather Allain', 'Completed'],
  ['Kelsey Babineau', '18:00', '19:00', 'Paul Duguay', 'No-show'],
  ['Rachel Thibodeau', '09:00', '10:00', 'Carole Friolet', 'Completed'],
  ['Rachel Thibodeau', '10:30', '11:30', 'Jeff Savoy', 'Completed'],
  ['Rachel Thibodeau', '12:00', '13:00', 'Melissa Thorne', 'Completed'],
  ['Rachel Thibodeau', '13:30', '14:30', 'Ginette Daigle', 'Late cancel'],
  ['Rachel Thibodeau', '15:00', '16:00', 'Alex Boudreau', 'Completed'],
  ['Rachel Thibodeau', '17:00', '18:30', 'Marielle Haché', 'Completed'],
  ['Rachel Thibodeau', '19:00', '19:45', 'Sonia Gagnon', 'Completed'],
]);

const TUE = rowsFor('2026-10-13', [
  ['Amira Haddad', '09:00', '10:30', 'Rhéal Doucette', 'Completed'],
  ['Amira Haddad', '11:00', '12:00', 'Tanya Mercier', 'Completed'],
  ['Amira Haddad', '12:30', '13:30', 'Gaston Leblanc', 'Refilled'],
  ['Amira Haddad', '14:00', '15:00', 'Yvette Landry', 'Cancelled'],
  ['Amira Haddad', '15:30', '16:30', 'Craig Murphy', 'Completed'],
  ['Amira Haddad', '17:00', '18:00', 'Pauline Cormier', 'Late cancel'],
  ['Josée Landry', '09:15', '10:15', 'Dwayne Arseneau', 'Completed'],
  ['Josée Landry', '10:30', '11:30', 'Linda Comeau', 'Completed'],
  ['Josée Landry', '12:00', '13:00', 'Michel Gaudet', 'No-show'],
  ['Josée Landry', '13:30', '14:30', 'Susan Vienneau', 'Completed'],
  ['Josée Landry', '15:00', '16:30', 'Bruno Martin', 'Completed'],
  ['Josée Landry', '17:00', '18:00', 'Camille Rioux', 'Completed'],
  ['Marc Cormier', '09:00', '10:00', 'Jolene Haché', 'Completed'],
  ['Marc Cormier', '10:15', '11:15', 'Normand Gionet', 'Late cancel'],
  ['Marc Cormier', '11:30', '12:30', 'Erin McLaughlin', 'Completed'],
  ['Marc Cormier', '13:00', '14:00', 'Claude Doiron', 'Completed'],
  ['Marc Cormier', '14:30', '15:30', 'Tammy Sirois', 'Cancelled'],
  ['Marc Cormier', '16:00', '17:00', 'Réjean Cyr', 'Completed'],
  ['Marc Cormier', '17:30', '18:45', 'Louise Thibault', 'Completed'],
  ['Rachel Thibodeau', '09:30', '10:30', 'Ian Bernard', 'Completed'],
  ['Rachel Thibodeau', '11:00', '12:00', 'Karine Pelletier', 'Completed'],
  ['Rachel Thibodeau', '12:30', '13:15', 'Roch Cormier', 'Completed'],
  ['Rachel Thibodeau', '13:45', '14:45', 'Debbie Walsh', 'Late cancel'],
  ['Rachel Thibodeau', '15:15', '16:15', 'Georges Poirier', 'Completed'],
  ['Rachel Thibodeau', '16:45', '17:45', 'Mireille Ouellette', 'Completed'],
  ['Rachel Thibodeau', '18:30', '19:30', 'Aaron Fitzpatrick', 'Completed'],
]);

const WED = rowsFor('2026-10-14', [
  ['Dave Melanson', '09:00', '10:00', 'Hélène Bastarache', 'Completed'],
  ['Dave Melanson', '10:30', '11:30', 'Trevor Hanson', 'Completed'],
  ['Dave Melanson', '12:00', '13:30', 'Odette Savoie', 'Completed'],
  ['Dave Melanson', '14:00', '15:00', 'Jean-Marc Long', 'Late cancel'],
  ['Dave Melanson', '15:30', '16:30', 'Stacey Nowlan', 'Completed'],
  ['Dave Melanson', '17:00', '18:00', 'Rolande Gallant', 'Completed'],
  ['Dave Melanson', '18:30', '19:30', 'Pierre Allain', 'Completed'],
  ['Kelsey Babineau', '09:00', '10:00', 'Lorraine Chiasson', 'Completed'],
  ['Kelsey Babineau', '10:15', '11:15', 'Matt Girouard', 'Cancelled'],
  ['Kelsey Babineau', '11:30', '12:30', 'Nadine Belliveau', 'Completed'],
  ['Kelsey Babineau', '13:00', '14:00', 'Alan Frenette', 'Refilled'],
  ['Kelsey Babineau', '14:30', '15:30', 'Cindy Vautour', 'Completed'],
  ['Kelsey Babineau', '16:00', '17:00', 'Fabien Arsenault', 'No-show'],
  ['Marc Cormier', '09:30', '10:30', 'Joyce LeBlanc', 'Completed'],
  ['Marc Cormier', '11:00', '12:00', 'Dale Hébert', 'Completed'],
  ['Marc Cormier', '12:30', '13:30', 'Sylvie Roy', 'Late cancel'],
  ['Marc Cormier', '14:00', '15:30', 'Andrew Paulin', 'Completed'],
  ['Marc Cormier', '16:00', '17:00', 'Brigitte Maillet', 'Refilled'],
  ['Marc Cormier', '17:30', '18:30', 'Kyle Savoy', 'Completed'],
  ['Rachel Thibodeau', '09:00', '10:00', 'Fernande Legere', 'Completed'],
  ['Rachel Thibodeau', '10:15', '11:00', 'Greg Daigle', 'Completed'],
  ['Rachel Thibodeau', '11:30', '12:30', 'Manon Thériault', 'Completed'],
  ['Rachel Thibodeau', '13:00', '14:00', 'Bobby Richard', 'Cancelled'],
  ['Rachel Thibodeau', '14:15', '15:15', 'Janine Comeau', 'Completed'],
  ['Rachel Thibodeau', '16:00', '17:30', 'Terry Gauvin', 'Completed'],
  ['Rachel Thibodeau', '18:00', '19:00', 'Renée Cormier', 'Completed'],
]);

const THU = rowsFor('2026-10-15', [
  ['Josée Landry', '09:00', '10:00', 'Hailey Collin', 'Completed'],
  ['Marc Cormier', '09:00', '10:00', 'Thérèse White', 'Completed'],
  ['Josée Landry', '10:15', '10:45', 'Eric Belanger', 'Cancelled'],
  ['Dave Melanson', '11:00', '12:00', 'Tim Bourgoin', 'No-show'],
  ['Josée Landry', '11:00', '11:45', 'Martine Beaulieu', 'Completed'],
  ['Rachel Thibodeau', '11:00', '11:30', 'Hailey Clark', 'Completed'],
  ['Marc Cormier', '11:15', '12:15', 'Roger Gould', 'Late cancel'],
  ['Rachel Thibodeau', '11:45', '12:30', 'Joanne Lanteigne', 'Completed'],
  ['Josée Landry', '12:00', '12:45', 'Courtney Haley', 'Completed'],
  ['Dave Melanson', '12:15', '13:45', "Francine O'Neill", 'Completed'],
  ['Marc Cormier', '12:30', '14:00', 'Sylvain Deveau', 'Completed'],
  ['Rachel Thibodeau', '12:45', '13:45', 'Laurie Wheaton', 'Completed'],
  ['Josée Landry', '13:00', '14:00', 'Derek Lirette', 'Completed'],
  ['Dave Melanson', '14:00', '15:00', 'Valérie Paulin', 'Late cancel'],
  ['Rachel Thibodeau', '14:00', '14:30', 'Rosalie Vautour-Roy', 'Completed'],
  ['Josée Landry', '14:15', '15:15', 'Megan Collin', 'Completed'],
  ['Rachel Thibodeau', '14:45', '15:45', 'Courtney Bourgoin', 'Cancelled'],
  ['Dave Melanson', '15:15', '16:15', 'Jasmine McKay', 'Completed'],
  ['Josée Landry', '15:30', '16:30', 'Élise Maillet-Roy', 'Completed'],
  ['Rachel Thibodeau', '16:00', '17:00', 'Joanne Frenette', 'Late cancel'],
  ['Dave Melanson', '16:30', '18:00', 'Cédric Breau', 'Completed'],
  ['Josée Landry', '16:45', '17:45', 'Alain Clark', 'Completed'],
  ['Rachel Thibodeau', '17:15', '18:45', 'Shannon Pothier', 'Completed'],
  ['Dave Melanson', '18:15', '19:15', 'Cathy Aucoin', 'Completed'],
  ['Rachel Thibodeau', '19:00', '19:30', 'Dominique Caissy', 'Completed'],
]);

const FRI = rowsFor('2026-10-16', [
  ['Amira Haddad', '09:00', '10:00', 'Doris Bourque', 'Completed'],
  ['Amira Haddad', '10:30', '11:30', 'Samuel Ricker', 'Completed'],
  ['Amira Haddad', '12:00', '13:00', 'Lucie Thibodeau', 'Late cancel'],
  ['Amira Haddad', '13:30', '14:30', 'Harold Savoie', 'Completed'],
  ['Amira Haddad', '15:00', '16:00', 'Renelle Pitre', 'Refilled'],
  ['Amira Haddad', '16:30', '17:30', 'Chris Boudreau', 'Completed'],
  ['Josée Landry', '09:00', '10:00', 'Gisèle Vienneau', 'Completed'],
  ['Josée Landry', '10:15', '11:15', 'Lance Nadeau', 'No-show'],
  ['Josée Landry', '11:30', '12:30', 'Marcelle Gagné', 'Completed'],
  ['Josée Landry', '13:00', '14:00', 'Ethan Poirier', 'Completed'],
  ['Josée Landry', '14:30', '15:45', 'Beverly Hawkes', 'Completed'],
  ['Josée Landry', '16:15', '17:15', 'Claudette Leger', 'Cancelled'],
  ['Josée Landry', '17:30', '18:30', 'Jacques Mazerolle', 'Completed'],
  ['Kelsey Babineau', '09:30', '10:30', 'Danielle Girouard', 'Completed'],
  ['Kelsey Babineau', '11:00', '12:00', 'Roland Hache', 'Completed'],
  ['Kelsey Babineau', '12:30', '13:30', 'Carla Doucet', 'Completed'],
  ['Kelsey Babineau', '14:00', '15:00', 'Winston Clark', 'Late cancel'],
  ['Kelsey Babineau', '15:30', '16:30', 'Emilie Arseneau', 'Completed'],
  ['Kelsey Babineau', '17:00', '18:00', 'Yves Robichaud', 'Completed'],
  ['Marc Cormier', '09:00', '10:00', 'Hazel Landry', 'Completed'],
  ['Marc Cormier', '10:30', '11:30', 'Donovan Gaudet', 'Completed'],
  ['Marc Cormier', '12:00', '13:30', 'Rita Savoy', 'Completed'],
  ['Marc Cormier', '14:00', '15:00', 'Wade Comeau', 'Cancelled'],
  ['Marc Cormier', '15:30', '16:30', 'Anita Duguay', 'Completed'],
  ['Marc Cormier', '17:00', '18:00', 'Gérard Hébert', 'Completed'],
  ['Marc Cormier', '18:30', '19:30', 'Natalie Cyr', 'Completed'],
]);

const SAT = rowsFor('2026-10-17', [
  ['Dave Melanson', '09:00', '10:00', 'Lionel Gallant', 'Completed'],
  ['Dave Melanson', '10:30', '11:30', 'Peggy Allain', 'Completed'],
  ['Dave Melanson', '12:00', '13:00', 'Todd Frenette', 'Late cancel'],
  ['Dave Melanson', '13:30', '14:30', 'Sheila Bastarache', 'Completed'],
  ['Dave Melanson', '15:00', '16:00', 'Mathieu Daigle', 'Completed'],
  ['Josée Landry', '09:30', '10:30', 'Yolande Chiasson', 'Completed'],
  ['Josée Landry', '11:00', '12:00', 'Gavin Doiron', 'Refilled'],
  ['Josée Landry', '12:30', '13:30', 'Pamela Rioux', 'Completed'],
  ['Josée Landry', '14:00', '15:00', 'Armand Basque', 'No-show'],
  ['Josée Landry', '15:30', '16:30', 'Louisette Pelletier', 'Completed'],
  ['Marc Cormier', '09:00', '10:30', 'Randy McLaughlin', 'Completed'],
  ['Marc Cormier', '11:00', '12:00', 'Corinne Long', 'Completed'],
  ['Marc Cormier', '12:30', '13:30', 'Norman Thériault', 'Cancelled'],
  ['Marc Cormier', '14:00', '15:00', 'Joanie Belliveau', 'Completed'],
  ['Marc Cormier', '15:30', '17:00', 'Vincent Richard', 'Completed'],
  ['Rachel Thibodeau', '09:00', '10:00', 'Monica Gauvin', 'Completed'],
  ['Rachel Thibodeau', '10:15', '11:15', 'Dennis Sirois', 'Completed'],
  ['Rachel Thibodeau', '11:45', '12:45', 'Annette Mercier', 'Late cancel'],
  ['Rachel Thibodeau', '13:15', '14:15', 'Scott Hanson', 'Completed'],
  ['Rachel Thibodeau', '14:45', '15:45', 'Estelle Cormier', 'Completed'],
]);

/** The whole made-up week, in day order. */
export const SAMPLE_WEEK: readonly WeekRow[] = [...MON, ...TUE, ...WED, ...THU, ...FRI, ...SAT];
