/**
 * Host half of the `session-marks` bundle.
 *
 * The whole capability lives in the browser half: annotations are a reading aid
 * over the rendered transcript. They are stored in the browser, never enter the
 * Session log, and reach the model only as the ordinary quoted text the user
 * chose to send. Keeping the Host half empty means the bundle changes nothing
 * about how a Session is recorded, replayed, forked, or compacted — and costs
 * no tokens until the user actually asks.
 */
export function apply() {}
