// "Abridge-ready handoff" export. There is no public Abridge developer API, so this is
// the partnership story instead: SwiftCode captures the moment too fast for the cloud,
// then hands a structured record forward into platforms like Abridge. FHIR-flavored
// means field naming inspired by FHIR resources, not a claim of FHIR compliance.

const EVENT_LABELS = {
  code_started: "Code started",
  cpr_started: "CPR started",
  cpr_resumed: "CPR resumed",
  cpr_paused: "CPR paused",
  rhythm_check: "Rhythm check",
  shock_delivered: "Shock delivered",
  med_administered: "Medication administered",
  airway_placed: "Airway placed",
  access_established: "Access established",
  rosc_achieved: "ROSC achieved",
  code_terminated: "Code terminated",
  note: "Note",
};

// RxNorm-style ingredient display names (Title Case), not RxNorm codes — no RxCUI is
// fabricated here, only the closed ACLS drug list's conventional display form.
const RXNORM_DISPLAY_NAMES = {
  epinephrine: "Epinephrine",
  amiodarone: "Amiodarone",
  lidocaine: "Lidocaine",
  atropine: "Atropine",
  adenosine: "Adenosine",
  "calcium chloride": "Calcium Chloride",
  "sodium bicarbonate": "Sodium Bicarbonate",
  magnesium: "Magnesium Sulfate",
  naloxone: "Naloxone",
};

function toFhirResource(event) {
  const iso = new Date(event.timestamp).toISOString();
  const base = { id: event.id, source: event.source, confidence: event.confidence };

  switch (event.event_type) {
    case "code_started":
      return { ...base, resourceType: "Encounter", status: "in-progress", period: { start: iso } };
    case "cpr_started":
    case "cpr_resumed":
    case "cpr_paused":
      return {
        ...base,
        resourceType: "Procedure",
        code: { text: "Cardiopulmonary resuscitation" },
        status: event.event_type === "cpr_paused" ? "on-hold" : "in-progress",
        performedDateTime: iso,
      };
    case "rhythm_check":
      return {
        ...base,
        resourceType: "Observation",
        code: { text: "Cardiac rhythm, reported verbatim" },
        valueString: event.rhythm_reported,
        effectiveDateTime: iso,
      };
    case "shock_delivered":
      return {
        ...base,
        resourceType: "Procedure",
        code: { text: "Defibrillation" },
        extension: event.energy_joules != null ? { energyJoules: event.energy_joules } : undefined,
        performedDateTime: iso,
      };
    case "med_administered":
      return {
        ...base,
        resourceType: "MedicationAdministration",
        status: "completed",
        medicationCodeableConcept: { text: RXNORM_DISPLAY_NAMES[event.drug] || event.drug },
        dosage: { text: [event.dose, event.route].filter(Boolean).join(" ") || undefined },
        effectiveDateTime: iso,
      };
    case "airway_placed":
      return {
        ...base,
        resourceType: "Procedure",
        code: { text: `Airway placement: ${event.airway_type || "unspecified"}` },
        performedDateTime: iso,
      };
    case "access_established":
      return {
        ...base,
        resourceType: "Procedure",
        code: { text: "Vascular access" },
        extension: { route: event.route, site: event.site },
        performedDateTime: iso,
      };
    case "rosc_achieved":
      return {
        ...base,
        resourceType: "Observation",
        code: { text: "Return of spontaneous circulation" },
        effectiveDateTime: iso,
      };
    case "code_terminated":
      return { ...base, resourceType: "Encounter", status: "finished", period: { end: iso } };
    case "note":
    default:
      return { ...base, resourceType: "Communication", status: "completed", payload: { text: event.verbatim }, sent: iso };
  }
}

function computeOutcome(events) {
  const rosc = events.find((e) => e.event_type === "rosc_achieved");
  const terminated = events.find((e) => e.event_type === "code_terminated");
  const started = events.find((e) => e.event_type === "code_started");

  if (rosc) return { status: "rosc_achieved", timestamp: new Date(rosc.timestamp).toISOString() };
  if (terminated) return { status: "code_terminated", timestamp: new Date(terminated.timestamp).toISOString() };
  return { status: "in_progress", timestamp: started ? new Date(started.timestamp).toISOString() : null };
}

function computeDurations(events) {
  const started = events.find((e) => e.event_type === "code_started");
  const end = events.find((e) => e.event_type === "rosc_achieved" || e.event_type === "code_terminated");
  if (!started) return { totalCodeSeconds: null };
  const endTimestamp = end ? end.timestamp : Math.max(...events.map((e) => e.timestamp));
  return { totalCodeSeconds: Math.round((endTimestamp - started.timestamp) / 1000) };
}

function computeEpiIntervalSeconds(events) {
  const doses = events
    .filter((e) => e.event_type === "med_administered" && e.drug === "epinephrine")
    .sort((a, b) => a.timestamp - b.timestamp);
  return doses.map((dose, i) => ({
    timestamp: new Date(dose.timestamp).toISOString(),
    secondsSincePreviousDose: i === 0 ? null : Math.round((dose.timestamp - doses[i - 1].timestamp) / 1000),
  }));
}

// Structured, FHIR-flavored export for handoff into a documentation platform.
export function buildStructuredExport(events, { profileName } = {}) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  return {
    exportedAt: new Date().toISOString(),
    exportLabel: "SwiftCode Abridge-ready handoff",
    profile: profileName,
    outcome: computeOutcome(sorted),
    durations: computeDurations(sorted),
    epinephrineIntervals: computeEpiIntervalSeconds(sorted),
    events: sorted.map(toFhirResource),
  };
}

function eventDetail(e) {
  switch (e.event_type) {
    case "med_administered":
      return [RXNORM_DISPLAY_NAMES[e.drug] || e.drug, e.dose, e.route].filter(Boolean).join(" ");
    case "rhythm_check":
      return e.rhythm_reported ? `reported as "${e.rhythm_reported}"` : "";
    case "shock_delivered":
      return e.energy_joules != null ? `${e.energy_joules} J` : "";
    case "airway_placed":
      return e.airway_type || "";
    case "access_established":
      return [e.route, e.site].filter(Boolean).join(" ");
    case "note":
      return e.verbatim || "";
    default:
      return "";
  }
}

// Markdown clinical narrative: the event table plus, when available, the Claude-generated
// narrative and debrief text produced separately by summary.js.
export function buildMarkdownExport(events, { narrativeText, debriefText, profileName } = {}) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const outcome = computeOutcome(sorted);
  const durations = computeDurations(sorted);

  const lines = [];
  lines.push("# SwiftCode Record");
  lines.push("");
  lines.push(`Exported: ${new Date().toISOString()}`);
  if (profileName) lines.push(`Profile: ${profileName}`);
  lines.push(`Outcome: ${outcome.status}${outcome.timestamp ? ` at ${outcome.timestamp}` : ""}`);
  if (durations.totalCodeSeconds != null) {
    lines.push(`Total code duration: ${Math.round(durations.totalCodeSeconds / 60)} min`);
  }
  lines.push("");

  const escapeCell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

  lines.push("## Event Log");
  lines.push("");
  lines.push("| Time | Event | Detail | Source |");
  lines.push("|---|---|---|---|");
  for (const e of sorted) {
    const time = new Date(e.timestamp).toISOString();
    const label = EVENT_LABELS[e.event_type] || e.event_type;
    lines.push(`| ${time} | ${label} | ${escapeCell(eventDetail(e))} | ${e.source || ""} |`);
  }
  lines.push("");

  if (narrativeText) {
    lines.push("## Code Record Narrative");
    lines.push("");
    lines.push(narrativeText);
    lines.push("");
  }

  if (debriefText) {
    lines.push("## Plus/Delta Debrief");
    lines.push("");
    lines.push(debriefText);
    lines.push("");
  }

  return lines.join("\n");
}
