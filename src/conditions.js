/**
 * Evaluate a single if-check against vars
 * { field, operator, value }
 */
function evaluateCheck(check, vars) {
  const raw      = vars[check.field] ?? vars[check.field?.toLowerCase()] ?? '';
  const fieldVal = String(raw).toLowerCase().trim();
  const condVal  = String(check.value || '').toLowerCase().trim();

  switch (check.operator) {
    case 'equals':       return fieldVal === condVal;
    case 'not_equals':   return fieldVal !== condVal;
    case 'contains':     return fieldVal.includes(condVal);
    case 'not_contains': return !fieldVal.includes(condVal);
    case 'starts_with':  return fieldVal.startsWith(condVal);
    case 'ends_with':    return fieldVal.endsWith(condVal);
    case 'is_empty':     return fieldVal === '';
    case 'is_not_empty': return fieldVal !== '';
    default:             return false;
  }
}

/**
 * A condition now looks like:
 * {
 *   checks: [
 *     { field: 'NotificationUsername', operator: 'equals', value: 'john' },
 *     { field: 'status', operator: 'equals', value: 'approved' }
 *   ],
 *   logic: 'AND' | 'OR',   // default AND
 *   recipients: ['23480...'],
 *   template_id: 5,
 *   custom_message: ''
 * }
 *
 * ALL checks must pass (AND) or ANY check must pass (OR) for the condition to fire.
 */
function evaluateCondition(cond, vars) {
  const checks = cond.checks || [];
  if (!checks.length) return false;

  const logic = (cond.logic || 'AND').toUpperCase();
  if (logic === 'OR') {
    return checks.some(c => evaluateCheck(c, vars));
  }
  // Default: AND
  return checks.every(c => evaluateCheck(c, vars));
}

/**
 * Apply all conditions to a rule.
 *
 * recipient_mode per condition:
 *   'replace' — ignore base recipients, only use this condition's recipients
 *   'add'     — add this condition's recipients on top of base (default)
 *
 * If ANY matching condition is 'replace', base recipients are dropped
 * and only replace-condition recipients are used (plus any 'add' conditions
 * on top of those).
 */
function applyConditions(rule, vars, baseRecipients) {
  const conditions = JSON.parse(rule.conditions || '[]');

  let template_id    = rule.template_id;
  let custom_message = rule.custom_message || '';
  const matched      = [];

  // Separate matched conditions by mode
  const replaceRecipients = [];
  const addRecipients     = [];
  let hasReplace          = false;

  // Normalize a recipient string for dedup comparison
  const norm = r => String(r).trim().toLowerCase();
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter(r => {
      const key = norm(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const addUnique = (target, items) => {
    const existing = new Set(target.map(norm));
    for (const r of items) {
      if (!existing.has(norm(r))) { target.push(r); existing.add(norm(r)); }
    }
  };

  for (const cond of conditions) {
    if (evaluateCondition(cond, vars)) {
      matched.push(cond);

      if (cond.recipients?.length) {
        const condRecips = cond.recipients.map(r => String(r).trim()).filter(Boolean);
        if (cond.recipient_mode === 'replace') {
          hasReplace = true;
          addUnique(replaceRecipients, condRecips);
        } else {
          addUnique(addRecipients, condRecips);
        }
      }

      if (cond.template_id) template_id = cond.template_id;
      if (cond.custom_message) custom_message = cond.custom_message;
    }
  }

  // Build final recipients
  let recipients;
  if (hasReplace) {
    recipients = [...replaceRecipients];
    addUnique(recipients, addRecipients);
  } else {
    recipients = dedupe([...baseRecipients]);
    addUnique(recipients, addRecipients);
  }

  return { recipients, template_id, custom_message, matched };
}

module.exports = { evaluateCondition, evaluateCheck, applyConditions };
