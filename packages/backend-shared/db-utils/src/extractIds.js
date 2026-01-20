// General list normaliser: accepts CSV string or array; trims, filters, dedupes.
// Options:
// - coerce: 'number' | 'string' (default 'number')
// - pattern: optional RegExp to validate tokens (overrides numeric rules when supplied)
// - allowNegative: only used when coerce === 'number' (default false)
// - allowZero: only used when coerce === 'number' (default true)
// - dedupe: remove duplicates (default true)
export function normaliseList(input, {
	coerce = 'number',
	pattern,
	allowNegative = false,
	allowZero = true,
	dedupe = true,
} = {}) {
	const out = dedupe ? new Set() : [];
	const add = (val) => {
		if (dedupe) out.add(val);
		else out.push(val);
	};

	const toTokens = (val) => {
		if (Array.isArray(val)) return val;
		if (typeof val === 'string') return val.split(',');
		return [];
	};

	const numericPattern = (() => {
		if (pattern) return pattern;
		if (coerce !== 'number') return null;
		// default numeric validation
		return allowNegative ? /^-?\d+$/ : /^\d+$/;
	})();

	for (let v of toTokens(input)) {
		if (typeof v === 'number') v = String(v);
		if (typeof v !== 'string') continue;

		const t = v.trim();
		if (!t) continue;

		if (coerce === 'number') {
			if (numericPattern && !numericPattern.test(t)) continue;
			const n = parseInt(t, 10);
			if (!Number.isFinite(n)) continue;
			if (!allowZero && n === 0) continue;
			if (!allowNegative && n < 0) continue;
			add(n);
		} else { // 'string'
			if (pattern && !pattern.test(t)) continue;
			add(t);
		}
	}

	return dedupe ? Array.from(out) : out;
}

// Extract unique numeric IDs from properties using provided field names (in order)
export function extractIdsFromProperties(properties, fieldNames = ['DIDs', 'dids', 'CIDs', 'cids']) {
    const out = new Set();
    if (!Array.isArray(properties)) return [];
    for (const rec of properties) {
        if (!rec || typeof rec !== 'object') continue;
        for (const key of fieldNames) {
            const raw = rec[key];
            if (raw == null) continue;
            normaliseList(raw, { coerce: "string" }).forEach(id => out.add(id));
            break; // stop at first present field for this record
        }
    }
    return Array.from(out);
}

// Convenience wrappers
export const extractDidsFromProperties = (properties, fieldName = 'DIDs') =>
    extractIdsFromProperties(properties, [fieldName, fieldName.toLowerCase()]);

export const extractCidsFromProperties = (properties, fieldName = 'CIDs') =>
    extractIdsFromProperties(properties, [fieldName, fieldName.toLowerCase()]);

// If you need both in one pass:
export function extractCidsOrDidsFromProperties(properties) {
    return {
        dids: extractDidsFromProperties(properties),
        cids: extractCidsFromProperties(properties),
    };
}
