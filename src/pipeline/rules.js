// Deterministic keyword/regex ACLS event matcher. Synchronous, no I/O, sub-millisecond.
// This is the layer the demo survives on if the LLM and every network link are dead.
// Only ever emits events from the closed schema list; never interprets a rhythm.

const DRUGS = [
  { drug: "epinephrine", aliases: ["epinephrine", "epi's", "epis", "epi"] },
  { drug: "amiodarone", aliases: ["amiodarone"] },
  { drug: "lidocaine", aliases: ["lidocaine"] },
  { drug: "atropine", aliases: ["atropine"] },
  { drug: "adenosine", aliases: ["adenosine"] },
  { drug: "calcium chloride", aliases: ["calcium chloride", "calcium"] },
  { drug: "sodium bicarbonate", aliases: ["sodium bicarbonate", "bicarbonate", "bicarb"] },
  { drug: "magnesium", aliases: ["magnesium sulfate", "magnesium", "mag sulfate"] },
  { drug: "naloxone", aliases: ["naloxone", "narcan"] },
  { drug: "epinephrine", aliases: ["epinephrine", "epi's", "epis", "epi", "adrenaline"] }, // add adrenaline
  { drug: "vasopressin", aliases: ["vasopressin", "vaso"] },
  { drug: "procainamide", aliases: ["procainamide", "pro-cain"] },
];

const NEGATION_PATTERN = /\b(hold off|holding off|hold\b|withhold|no\s|not giving|don'?t give|do not give|skip(ping)?|without|on hold|defer|delay)\b/i;
const STRONG_ADMIN_MARKER =
  /\b(push(ed|ing)?|giv(e|en|ing)|gave|administer(ed|ing)?|on board|another round|round of|going in)\b/i;

const DOSE_PATTERN = /(\d+(?:\.\d+)?)\s*(milligrams?|mg)\b/i;
const ROUTE_PATTERN = /\b(IV push|IV|IO)\b/i;

const TEMPORAL_SUPPRESSION =
  /\b(yesterday|last (week|shift|time|night)|previously|earlier (today|this shift)|the other day)\b/i;

const NUMBER_WORDS = [
  [/\bthree\s*sixty\b/i, 360],
  [/\bthree\s*fifty\b/i, 350],
  [/\bthree\s*hundred\b/i, 300],
  [/\btwo\s*hundred\b/i, 200],
  [/\bone\s*seventy\b/i, 170],
  [/\bone\s*fifty\b/i, 150],
  [/\bone\s*twenty\b/i, 120],
  [/\bone\s*hundred\b/i, 100],
];

const SHOCK_TRIGGER = /\b(shock(ed|ing)?(\s+delivered|\s+given)?|defibrillat(e|ed|ing))\b/i;

const RHYTHM_PATTERNS = [
  /\bpulseless v-?tach(ycardia)?\b/i,
  /\bventricular fibrillation\b/i,
  /\bventricular tachycardia\b/i,
  /\bv-?fib\b/i,
  /\bv-?tach\b/i,
  /\basystole\b/i,
  /\bpulseless electrical activity\b/i,
  /\bpea\b/i,
  /\bnormal sinus( rhythm)?\b/i,
  /\bsinus rhythm\b/i,
  /\batrial fibrillation\b/i,
  /\bafib\b/i,
];

const AIRWAY_PATTERNS = [
  [/\bking airway\b/i, "King airway"],
  [/\blma\b/i, "LMA"],
  [/\bbag valve mask\b|\bbvm\b/i, "BVM"],
  [/\bintubat(e|ed|ing|ion)\b/i, "ETT"],
];

const ACCESS_PATTERN = /\b(IV|IO)\s+(access|line|established|placed|in)\b|\bgot (an|a)\s+(IV|IO)\b/i;
const ACCESS_SITE_PATTERN = /\b((right|left)\s+)?(AC|antecubital|EJ|external jugular|femoral|tibia|tibial)\b/i;

const ROSC_PATTERN = /\b(rosc|return of spontaneous circulation|we have a pulse|got a pulse back|pulse('?s| is) back)\b/i;
const TERMINATION_PATTERN =
  /\b(time of death|calling it|call(ing)? the code|stop(ping)? the code|terminat(e|ing) the code|ending the code)\b/i;
const CODE_STARTED_PATTERN =
  /\b(code blue|calling a code|starting the code|code has started|code started|rapid response (called|activated))\b/i;
const CPR_DEPTH_PATTERN = /\b(\d+)\s*(centimeters?|cm)\b|\b(too (shallow|deep)|good depth)\b/i;
const CPR_RATE_PATTERN = /\b(hundred|100|one-twenty|120)\s*(compressions?|per minute|bpm)\b/i;

const CPR_START_PATTERN = /\b(start(ing)?|begin(ning)?|initiat(e|ing))\s+(compressions|cpr)\b|\b(compressions|cpr)\s+(start(ed|ing)?|begun|begin)\b/i;
const CPR_RESUME_PATTERN =
  /\b(resum(e|ing|ed)|continu(e|ing)|back on)\s+(compressions|cpr)\b|\b(compressions|cpr)\s+resum(e|ed|ing)\b/i;
const CPR_PAUSE_PATTERN =
  /\b(hold(ing)?|paus(e|ing)|stop(ping)?)\s+(compressions|cpr)\b|\bcheck(ing)?\s+(the\s+)?(pulse|rhythm)\b|\bpulse check\b/i;

const GLUCOSE_PATTERN = /\bglucose\b|\bs\s?100\b|\bbs\b/i;
const TEMP_PATTERN = /\btemperature\b|\btemp\b/i;

const FALSE_POSITIVE_SUPPRESSION = [
  /\b(what (was|is)|review|check|could|should|might|might've)\s+(the\s+)?(rhythm|vfib|pulseless|asystole)/i,
  /\b(normal\s+)?(sinus\s+rhythm\s+)?for\s+\d+\s+seconds/i, // "normal sinus for 5 seconds" = rhythm check, not a reset
];


function matchCPRQuality(text, timestamp) {
  if (/\b(compressions?|cpr)\b/i.test(text)) {
    const depthMatch = text.match(CPR_DEPTH_PATTERN);
    const rateMatch = text.match(CPR_RATE_PATTERN);
    if (depthMatch || rateMatch) {
      return baseEvent("cpr_quality_check", timestamp, text, {
        depth_cm: depthMatch?.[1],
        rate_bpm: rateMatch?.[1],
      });
    }
  }
  return null;
}

// the previous one was missing some common patterns

function extractEnergyJoules(text) {
  const digitMatch = text.match(/\b(\d{2,3})\s*(joules?|j)\b/i);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  
  // Add: "charge to 200"
  const chargeMatch = text.match(/charge\s+(to\s+)?(\d{2,3})\b/i);
  if (chargeMatch) return parseInt(chargeMatch[2], 10);
  
  // Add: "360 joules" spelled out
  const bareDigitMatch = text.match(/\bto\s+(\d{2,3})\b/i);
  if (bareDigitMatch) return parseInt(bareDigitMatch[1], 10);
  
  for (const [pattern, value] of NUMBER_WORDS) {
    if (pattern.test(text)) return value;
  }
  return undefined;
}

function baseEvent(event_type, timestamp, verbatim, extra = {}) {
  return {
    event_type,
    timestamp,
    verbatim,
    confidence: "high",
    source: "rules",
    ...extra,
  };
}

function matchMedAdministered(text, timestamp) {
  for (const { drug, aliases } of DRUGS) {
    for (const alias of aliases) {
      const aliasPattern = new RegExp(`\\b${alias.replace(/'/g, "'?")}\\b`, "i");
      if (!aliasPattern.test(text)) continue;
      if (NEGATION_PATTERN.test(text)) return null;

      const impliedIn = new RegExp(`${alias.replace(/'/g, "'?")}\\s*('?s)?\\s*(is\\s+)?in\\b`, "i");
      if (!STRONG_ADMIN_MARKER.test(text) && !impliedIn.test(text)) continue;

      const doseMatch = text.match(DOSE_PATTERN);
      const routeMatch = text.match(ROUTE_PATTERN);
      return baseEvent("med_administered", timestamp, text, {
        drug,
        dose: doseMatch ? `${doseMatch[1]}mg` : undefined,
        route: routeMatch ? routeMatch[1].toUpperCase().replace(" PUSH", "") : undefined,
      });
    }
  }
  return null;
}

export function matchRules(text, timestamp = Date.now()) {
  if (!text || !text.trim()) return null;
  if (TEMPORAL_SUPPRESSION.test(text)) return null;

  if (ROSC_PATTERN.test(text)) return baseEvent("rosc_achieved", timestamp, text);
  if (TERMINATION_PATTERN.test(text)) return baseEvent("code_terminated", timestamp, text);

  if (SHOCK_TRIGGER.test(text)) {
    return baseEvent("shock_delivered", timestamp, text, { energy_joules: extractEnergyJoules(text) });
  }

  for (const pattern of RHYTHM_PATTERNS) {
    const match = text.match(pattern);
    if (match) return baseEvent("rhythm_check", timestamp, text, { rhythm_reported: match[0] });
  }

  const med = matchMedAdministered(text, timestamp);
  if (med) return med;

  for (const [pattern, airway_type] of AIRWAY_PATTERNS) {
    if (pattern.test(text)) return baseEvent("airway_placed", timestamp, text, { airway_type });
  }

  if (ACCESS_PATTERN.test(text)) {
    const routeMatch = text.match(/\b(IV|IO)\b/i);
    const siteMatch = text.match(ACCESS_SITE_PATTERN);
    return baseEvent("access_established", timestamp, text, {
      route: routeMatch ? routeMatch[1].toUpperCase() : undefined,
      site: siteMatch ? siteMatch[0] : undefined,
    });
  }

  if (CPR_PAUSE_PATTERN.test(text)) return baseEvent("cpr_paused", timestamp, text);
  if (CPR_RESUME_PATTERN.test(text)) return baseEvent("cpr_resumed", timestamp, text);
  if (CPR_START_PATTERN.test(text)) return baseEvent("cpr_started", timestamp, text);

  if (CODE_STARTED_PATTERN.test(text)) return baseEvent("code_started", timestamp, text);

  return null;
}
