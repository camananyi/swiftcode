// Append-only event log + confidence gating. Single ingestion point for both rules.js
// (always auto-logged) and extract.js (auto-logged above threshold, queued below it).
// Nothing is ever silently dropped: unrecognized/garbage input becomes a `note`.

export const EVENT_TYPES = new Set([
  "code_started",
  "cpr_started",
  "cpr_resumed",
  "cpr_paused",
  "rhythm_check",
  "shock_delivered",
  "med_administered",
  "airway_placed",
  "access_established",
  "rosc_achieved",
  "code_terminated",
  "note",
]);

export class EventStore {
  constructor({ confidence_threshold = 0.7 } = {}) {
    this.confidenceThreshold = confidence_threshold;
    this.log = [];
    this.pending = [];
    this._nextId = 1;
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(kind, payload) {
    for (const fn of this._listeners) fn(kind, payload);
  }

  _assignId() {
    return `evt_${this._nextId++}`;
  }

  // Pushes to the log without notifying — used when a caller needs to emit its own,
  // more specific notification for the same mutation (see confirmPending).
  _appendLog(event) {
    if (!EVENT_TYPES.has(event.event_type)) {
      throw new Error(`Unknown event_type "${event.event_type}"`);
    }
    const logged = { ...event, id: event.id ?? this._assignId() };
    delete logged.status;
    this.log.push(logged);
    return logged;
  }

  logEvent(event) {
    const logged = this._appendLog(event);
    this._notify("logged", logged);
    return logged;
  }

  queuePending(candidate) {
    const queued = { ...candidate, id: candidate.id ?? this._assignId(), status: "pending" };
    this.pending.push(queued);
    this._notify("pending", queued);
    return queued;
  }

  // Entry point for a freshly matched/extracted candidate event (not yet in the store).
  ingest(candidate) {
    if (!candidate || candidate.event_type === "none") return null;

    if (candidate.event_type === "note") {
      return this.logEvent(candidate);
    }

    if (candidate.source === "rules") {
      return this.logEvent(candidate);
    }

    if (candidate.source === "llm") {
      const confidence = typeof candidate.confidence === "number" ? candidate.confidence : 0;
      if (confidence >= this.confidenceThreshold) {
        return this.logEvent(candidate);
      }
      return this.queuePending(candidate);
    }

    // Unexpected shape (e.g. failed schema validation upstream) — never drop audio silently.
    return this.logEvent({
      event_type: "note",
      timestamp: candidate.timestamp ?? Date.now(),
      verbatim: candidate.verbatim ?? "",
      source: candidate.source ?? "unknown",
      confidence: candidate.confidence,
    });
  }

  confirmPending(id) {
    const idx = this.pending.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const [candidate] = this.pending.splice(idx, 1);
    const logged = this._appendLog({ ...candidate, source: "human-confirmed" });
    this._notify("pending-resolved", { id, action: "confirmed", event: logged });
    return logged;
  }

  rejectPending(id) {
    const idx = this.pending.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const [rejected] = this.pending.splice(idx, 1);
    this._notify("pending-resolved", { id, action: "rejected", event: rejected });
    return rejected;
  }

  // Demo-console reset: wipes the session so demo takes can restart without a server
  // restart. The live log remains append-only between resets.
  reset() {
    this.log = [];
    this.pending = [];
    this._nextId = 1;
  }

  getLog() {
    return [...this.log];
  }

  getPending() {
    return [...this.pending];
  }
}
