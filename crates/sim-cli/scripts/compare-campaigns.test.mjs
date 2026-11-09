import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compareCampaigns } from "./compare-campaigns.mjs";

function campaign(absent = false) {
  return {
    campaign: { seeds: 2, days: 30, size: 64, biome: 4, difficulty: "normal", climate: null,
      day_of_year: 0, day_scale: 30, absent_from: absent ? 8 : null },
    runs: [1, 2].map(seed => ({ seed, colonists_end: 0, deaths_absent: 6, enclosed_at_absence: true,
      livestock_lost_absent: 0, outdoor_stock_at_absence: 10, outdoor_stock_end: 20, lost_events: 0,
      deaths: { raid: 6, blessures: 0, famine: 0, froid: 0, maladie: 0, feu: 0, rixe: 0, inconnue: 0 } })),
  };
}
function input() {
  const data = { beforePresent: campaign(), beforeAbsent: campaign(true), afterPresent: campaign(), afterAbsent: campaign(true) };
  for (const r of data.afterAbsent.runs) { r.colonists_end = 3; r.deaths_absent = 2; r.stolen_units_absent = 4; }
  return data;
}
test("calcule les seuils exacts, les vols et la cohorte commune", () => {
  const r = compareCampaigns(input());
  assert.equal(r.passed, true);
  assert.equal(r.before.absent.stolenUnitsAbsent, null);
  assert.equal(r.after.absent.stolenUnitsAbsent, 8);
  assert.deepEqual(r.commonEnclosedCohort, { seeds: [1, 2], beforeDeaths: 12, afterDeaths: 4 });
  assert.equal(r.perSeed[0].afterOutdoorStockNetDecrease, -10);
});
test("un décès au-dessus du tiers échoue sans arrondi favorable", () => {
  const data = input(); data.afterAbsent.runs[0].deaths_absent++;
  const r = compareCampaigns(data);
  assert.equal(r.passed, false); assert.equal(r.checks.enclosedDeaths.pass, false);
});
test("les extinctions et la survie présente sont vérifiées séparément", () => {
  const data = input();
  data.afterAbsent.runs.forEach(r => r.colonists_end = 0);
  const r = compareCampaigns(data);
  assert.equal(r.checks.absentExtinction.pass, false);
  assert.equal(r.checks.presentSurvival.pass, true);
});
test("la cohorte commune ne masque pas le changement des enceintes", () => {
  const data = input(); data.beforeAbsent.runs[0].enclosed_at_absence = false;
  const r = compareCampaigns(data);
  assert.equal(r.before.absent.enclosedAtAbsence, 1);
  assert.equal(r.after.absent.enclosedAtAbsence, 2);
  assert.deepEqual(r.commonEnclosedCohort.seeds, [2]);
  assert.equal(r.checks.enclosedDeaths.pass, false);
});
test("l'ordre des graines n'importe pas et les données ne sont pas mutées", () => {
  const data = input(); data.afterAbsent.runs.reverse();
  const original = structuredClone(data);
  assert.deepEqual(compareCampaigns(data).perSeed.map(r => r.seed), [1, 2]);
  assert.deepEqual(data, original);
});
for (const [name, mutate, message] of [
  ["graines différentes", d => d.afterPresent.runs[0].seed = 9, /graines/],
  ["doublon", d => d.afterAbsent.runs[1].seed = 1, /dupliquée/],
  ["campagne tronquée", d => d.beforePresent.runs.pop(), /incomplète/],
  ["échelle différente", d => d.afterPresent.campaign.day_scale = 1, /day_scale/],
  ["départ différent", d => d.afterAbsent.campaign.absent_from = 9, /départ/],
  ["événement perdu", d => d.afterAbsent.runs[0].lost_events = 1, /événements perdus/],
  ["décès manquant", d => delete d.afterAbsent.runs[0].deaths.feu, /décès/],
]) test("refuse " + name, () => {
  const data = input(); mutate(data); assert.throws(() => compareCampaigns(data), message);
});
test("le départ dès le jour zéro et les enceintes nulles en présence sont valides", () => {
  const data = input();
  data.beforeAbsent.campaign.absent_from = data.afterAbsent.campaign.absent_from = 0;
  data.beforePresent.runs.forEach(r => r.enclosed_at_absence = null);
  assert.equal(compareCampaigns(data).passed, true);
});
test("perdre plus de deux colonies présentes fait échouer ce critère", () => {
  const data = input();
  for (const value of Object.values(data)) {
    value.campaign.seeds = 6;
    value.runs = Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(value.runs[i % 2]), seed: i + 1 }));
  }
  data.beforePresent.runs.forEach(r => r.colonists_end = 3);
  const report = compareCampaigns(data);
  assert.equal(report.checks.presentSurvival.minimum, 4);
  assert.equal(report.checks.presentSurvival.pass, false);
  assert.equal(report.passed, false);
});
test("le CLI émet du JSON et distingue succès, échec de seuil et entrée invalide", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rimlike-compare-"));
  try {
    const data = input();
    const paths = Object.keys(data).map(key => join(directory, key + ".json"));
    const save = () => Promise.all(Object.values(data).map((value, i) => writeFile(paths[i], JSON.stringify(value))));
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("./compare-campaigns.mjs", import.meta.url)), ...paths, "--json"], { encoding: "utf8" });
    await save();
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
    data.afterAbsent.runs[0].deaths_absent++;
    await save(); result = run();
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).passed, false);
    data.afterAbsent.runs[1].seed = 1;
    await save(); result = run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /dupliquée/);
    assert.equal(result.stdout, "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("une ancienne mesure impose l'échelle explicite", () => {
  const data = input(); delete data.beforePresent.campaign.day_scale;
  assert.throws(() => compareCampaigns(data), /legacy-day-scale/);
  assert.equal(compareCampaigns(data, { legacyDayScale: 30 }).passed, true);
});
