#!/usr/bin/env node
/**
 * Compare les quatre campagnes du contrat « colonie tient seule ».
 * Aucun modèle de jeu ici : seulement validation des cohortes et agrégats.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const deaths = ["raid", "blessures", "famine", "froid", "maladie", "feu", "rixe", "inconnue"];
const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function validate(value, label, absent, legacyDayScale) {
  requireThat(value && typeof value === "object" && value.campaign && Array.isArray(value.runs), label + " : format de campagne invalide");
  const c = value.campaign;
  const scale = c.day_scale ?? legacyDayScale;
  requireThat(integer(scale, 1) && scale <= 120, label + " : day_scale absent/invalide ; utiliser --legacy-day-scale pour une ancienne mesure");
  for (const key of ["days", "size", "seeds"]) requireThat(integer(c[key], 1), label + " : " + key + " invalide");
  requireThat(integer(c.biome) && typeof c.difficulty === "string" && integer(c.day_of_year), label + " : configuration incomplète");
  requireThat(c.climate === null || (c.climate && typeof c.climate === "object"), label + " : climat absent/invalide");
  requireThat(absent ? integer(c.absent_from) && c.absent_from < c.days : c.absent_from === null, label + " : mode présent/absent incohérent");
  requireThat(value.runs.length === c.seeds, label + " : campagne incomplète");
  const seeds = new Set();
  for (const r of value.runs) {
    requireThat(integer(r.seed) && !seeds.has(r.seed), label + " : graine absente ou dupliquée");
    seeds.add(r.seed);
    for (const key of ["colonists_end", "deaths_absent", "livestock_lost_absent", "outdoor_stock_at_absence", "outdoor_stock_end"]) {
      requireThat(integer(r[key]), label + " : " + key + " invalide à la graine " + r.seed);
    }
    requireThat(typeof r.enclosed_at_absence === "boolean" || (!absent && r.enclosed_at_absence === null), label + " : enceinte inconnue");
    requireThat(r.deaths && deaths.every(k => integer(r.deaths[k])), label + " : causes de décès invalides");
    requireThat(integer(r.lost_events) && r.lost_events === 0, label + " : événements perdus, bilan non fiable");
    requireThat((r.stolen_units_absent === undefined || integer(r.stolen_units_absent))
      && (r.stolen_units === undefined || integer(r.stolen_units)), label + " : vols invalides");
  }
  return { campaign: { ...c, day_scale: scale }, runs: [...value.runs].sort((a, b) => a.seed - b.seed) };
}
const sum = (runs, fn) => runs.reduce((n, r) => n + fn(r), 0);
function aggregate({ runs }) {
  const enclosed = runs.filter(r => r.enclosed_at_absence);
  return {
    alive: runs.filter(r => r.colonists_end > 0).length,
    extinct: runs.filter(r => r.colonists_end === 0).length,
    deaths: sum(runs, r => sum(deaths, key => r.deaths[key])),
    deathsByCause: Object.fromEntries(deaths.map(k => [k, sum(runs, r => r.deaths[k])])),
    enclosedAtAbsence: enclosed.length,
    enclosedDeathsAbsent: sum(enclosed, r => r.deaths_absent),
    livestockLostAbsent: sum(runs, r => r.livestock_lost_absent),
    stolenUnitsAbsent: runs.every(r => r.stolen_units_absent !== undefined) ? sum(runs, r => r.stolen_units_absent) : null,
  };
}

export function compareCampaigns(input, { legacyDayScale } = {}) {
  const labels = ["beforePresent", "beforeAbsent", "afterPresent", "afterAbsent"];
  const values = labels.map((label, i) => validate(input[label], label, i % 2 === 1, legacyDayScale));
  const [bp, ba, ap, aa] = values;
  for (const v of values.slice(1)) {
    for (const key of ["days", "size", "biome", "difficulty", "climate", "day_of_year", "day_scale", "seeds"]) {
      requireThat(same(bp.campaign[key], v.campaign[key]), "Campagnes incompatibles : " + key);
    }
    requireThat(same(bp.runs.map(r => r.seed), v.runs.map(r => r.seed)), "Les graines des quatre campagnes doivent être identiques");
  }
  requireThat(ba.campaign.absent_from === aa.campaign.absent_from, "Le jour du départ doit être identique");
  const before = { present: aggregate(bp), absent: aggregate(ba) };
  const after = { present: aggregate(ap), absent: aggregate(aa) };
  const common = ba.runs.filter((r, i) => r.enclosed_at_absence && aa.runs[i].enclosed_at_absence).map(r => r.seed);
  const isCommon = new Set(common);
  const checks = {
    presentSurvival: { actual: after.present.alive, minimum: Math.max(0, before.present.alive - 2),
      pass: after.present.alive >= before.present.alive - 2 },
    absentExtinction: { actual: after.absent.extinct, maximum: before.absent.extinct / 2,
      pass: after.absent.extinct * 2 <= before.absent.extinct },
    enclosedDeaths: { actual: after.absent.enclosedDeathsAbsent, maximum: before.absent.enclosedDeathsAbsent / 3,
      pass: after.absent.enclosedDeathsAbsent * 3 <= before.absent.enclosedDeathsAbsent },
  };
  return {
    configuration: { ...bp.campaign, absent_from: ba.campaign.absent_from, elapsed_ms: undefined, ticks: undefined },
    passed: Object.values(checks).every(c => c.pass), checks, before, after,
    commonEnclosedCohort: {
      seeds: common,
      beforeDeaths: sum(ba.runs.filter(r => isCommon.has(r.seed)), r => r.deaths_absent),
      afterDeaths: sum(aa.runs.filter(r => isCommon.has(r.seed)), r => r.deaths_absent),
    },
    perSeed: ba.runs.map((r, i) => {
      const a = aa.runs[i];
      return { seed: r.seed, beforeEnclosed: r.enclosed_at_absence, afterEnclosed: a.enclosed_at_absence,
        beforeAlive: r.colonists_end, afterAlive: a.colonists_end,
        beforeDeathsAbsent: r.deaths_absent, afterDeathsAbsent: a.deaths_absent,
        afterStolenUnitsAbsent: a.stolen_units_absent ?? null,
        afterLivestockLostAbsent: a.livestock_lost_absent,
        // Une baisse nette mêle consommation, production, rangement, feu et vols.
        // Elle ne mesure pas le pillage ; elle peut être négative.
        afterOutdoorStockNetDecrease: a.outdoor_stock_at_absence - a.outdoor_stock_end };
    }),
  };
}

async function main(argv) {
  const files = [];
  let legacyDayScale;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--legacy-day-scale") {
      legacyDayScale = Number(argv[++i]);
      requireThat(integer(legacyDayScale, 1) && legacyDayScale <= 120, "--legacy-day-scale attend un entier entre 1 et 120");
    }
    else if (argv[i].startsWith("--")) throw new Error("Option inconnue : " + argv[i]);
    else files.push(argv[i]);
  }
  requireThat(files.length === 4, "Usage : node compare-campaigns.mjs AVANT_PRESENT AVANT_ABSENT APRES_PRESENT APRES_ABSENT [--legacy-day-scale K] [--json]");
  const data = await Promise.all(files.map(async file => JSON.parse(await readFile(file, "utf8"))));
  const report = compareCampaigns(Object.fromEntries(["beforePresent", "beforeAbsent", "afterPresent", "afterAbsent"].map((k, i) => [k, data[i]])), { legacyDayScale });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("K=" + report.configuration.day_scale + " — " + (report.passed ? "3 critères satisfaits" : "critère non satisfait"));
    for (const [name, check] of Object.entries(report.checks)) {
      console.log((check.pass ? "OK" : "ÉCHEC") + " " + name + " : " + check.actual + ("minimum" in check ? " >= " + check.minimum : " <= " + check.maximum.toFixed(2)));
    }
    console.log("Cohorte murée commune : " + report.commonEnclosedCohort.seeds.length + " graines, " + report.commonEnclosedCohort.beforeDeaths + " → " + report.commonEnclosedCohort.afterDeaths + " morts après le départ.");
    console.log("Les seuils ne prouvent pas zéro décès. Détail des pertes avec --json.");
  }
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
