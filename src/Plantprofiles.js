// Plant profiles.
//
// A profile sets the TARGET. It never sets the rate.
//
// The drying model measures the pot — substrate, pot volume, root mass, leaf
// area, all folded into one observed rate — and knows nothing about the
// species. Choosing a profile moves the number the forecast counts down to.
// It does not change, and cannot change, what the pot is observed to do.
//
// benchmarkDays is the published general watering interval for plants of this
// kind. It exists for one purpose: to seed a drying rate before any cycle has
// been observed, so a plant added today still gets a forecast today. Three
// real cycles displace it almost entirely. It is a prior that evidence
// overwrites, never a source of thresholds.

export const PLANT_PROFILES = [
  {
    id: 'seed',
    label: 'Seed / germination',
    threshold: 75,
    cooldownHours: 4,
    benchmarkDays: 1,
    note: 'Roots are millimetres deep with no reserve. Must not dry out.',
  },
  {
    id: 'sapling',
    label: 'Sapling / seedling',
    threshold: 60,
    cooldownHours: 12,
    benchmarkDays: 2,
    note: 'Shallow roots. Recovers poorly from a single dry-out.',
  },
  {
    id: 'vegetable',
    label: 'Leafy vegetable',
    threshold: 55,
    cooldownHours: 12,
    benchmarkDays: 3,
    note: 'Growing continuously. Wilts quickly and visibly.',
  },
  {
    id: 'flowering',
    label: 'Flowering / fruiting',
    threshold: 50,
    cooldownHours: 24,
    benchmarkDays: 4,
    note: 'Mild water stress before flowering can be desirable.',
  },
  {
    id: 'houseplant',
    label: 'Houseplant',
    threshold: 35,
    cooldownHours: 48,
    benchmarkDays: 7,
    note: 'Root rot is the dominant risk here, not drought.',
  },
  {
    id: 'succulent',
    label: 'Succulent / cactus',
    threshold: 20,
    cooldownHours: 168,
    benchmarkDays: 21,
    note: 'Requires a full dry-down between waterings.',
  },
];

export const DEFAULT_PROFILE_ID = 'houseplant';

export function getProfile(id) {
  return PLANT_PROFILES.find((p) => p.id === id) || null;
}

// Drying rate implied by the published benchmark, in percentage points per
// hour: the span from saturated to this profile's threshold, spread across the
// benchmark interval. Used as a0 only until real cycles exist.
export function coldStartRate(profile) {
  if (!profile) return null;
  const span = Math.max(1, 100 - profile.threshold);
  const hours = Math.max(1, profile.benchmarkDays * 24);
  return span / hours;
}