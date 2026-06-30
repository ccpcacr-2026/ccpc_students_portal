/**
 * Portal Schema Manager
 * Abstracts tab configuration, field definitions, and form rendering
 * Used by both API and frontend components
 */

const FIELD_TYPES = {
  text: { label: 'Text Input', component: 'TextInput', htmlType: 'text' },
  email: { label: 'Email', component: 'EmailInput', htmlType: 'email' },
  number: { label: 'Number', component: 'NumberInput', htmlType: 'number' },
  date: { label: 'Date', component: 'DateInput', htmlType: 'date' },
  phone: { label: 'Phone', component: 'PhoneInput', htmlType: 'tel' },
  url: { label: 'URL', component: 'URLInput', htmlType: 'url' },
  currency: { label: 'Currency', component: 'CurrencyInput', htmlType: 'number' },
  textarea: { label: 'Text Area', component: 'TextAreaInput' },
  dropdown: { label: 'Dropdown', component: 'SelectInput' },
  checkbox: { label: 'Checkboxes', component: 'CheckboxGroup' },
  radio: { label: 'Radio Buttons', component: 'RadioGroup' },
  file: { label: 'File Upload', component: 'FileUpload' },
  group_label: { label: 'Section Header', component: 'GroupLabel' },
};

const CONDITION_OPERATORS = {
  eq: 'Equals',
  neq: 'Not Equals',
  contains: 'Contains',
  startswith: 'Starts With',
  gt: 'Greater Than',
  lt: 'Less Than',
  in_sheet: 'Has Submitted To',
  not_in_sheet: 'Has Not Submitted To',
};

/**
 * Parse and validate field configuration
 */
export function validateField(field) {
  if (!field.name) return { valid: false, error: 'Field name is required' };
  if (!field.type || !FIELD_TYPES[field.type]) {
    return { valid: false, error: `Invalid field type: ${field.type}` };
  }
  return { valid: true };
}

/**
 * Parse tab fields_json (JSON array of field definitions)
 */
export function parseTabFields(fieldsJson) {
  try {
    const fields = typeof fieldsJson === 'string' ? JSON.parse(fieldsJson) : fieldsJson;
    return Array.isArray(fields) ? fields : [];
  } catch (e) {
    console.error('Failed to parse fields_json:', e);
    return [];
  }
}

/**
 * Parse tab condition_json (visibility rules)
 */
export function parseTabCondition(conditionJson) {
  try {
    const cond = typeof conditionJson === 'string' ? JSON.parse(conditionJson) : conditionJson;
    return cond && typeof cond === 'object' ? cond : { logic: 'AND', rules: [] };
  } catch (e) {
    console.error('Failed to parse condition_json:', e);
    return { logic: 'AND', rules: [] };
  }
}

/**
 * Evaluate a single condition rule
 * Rules have: { operator, column, value }
 */
export function evaluateRule(rule, studentProfile, submittedTabs = []) {
  const { operator, column, value } = rule;

  if (!operator) return true;

  // Get student profile value (case-insensitive key match)
  const profileKeys = Object.keys(studentProfile || {});
  const normalizedColumn = (column || '').toLowerCase().replace(/[\s_]/g, '');
  const matchedKey = profileKeys.find(k =>
    k.toLowerCase().replace(/[\s_]/g, '') === normalizedColumn
  );
  const profileValue = String(studentProfile?.[matchedKey] || '').toLowerCase().trim();
  const targetValue = String(value || '').toLowerCase().trim();
  const targets = targetValue.split(',').map(s => s.trim());

  switch (operator) {
    case 'eq':
      return targets.includes(profileValue);
    case 'neq':
      return !targets.includes(profileValue);
    case 'contains':
      return targets.some(t => profileValue.includes(t));
    case 'startswith':
      return targets.some(t => profileValue.startsWith(t));
    case 'gt':
      return !isNaN(profileValue) && !isNaN(targetValue) && parseFloat(profileValue) > parseFloat(targetValue);
    case 'lt':
      return !isNaN(profileValue) && !isNaN(targetValue) && parseFloat(profileValue) < parseFloat(targetValue);
    case 'in_sheet':
      // Check if student has submitted to a specific tab
      return submittedTabs.includes(value);
    case 'not_in_sheet':
      return !submittedTabs.includes(value);
    default:
      return true;
  }
}

/**
 * Evaluate full tab visibility condition
 * condition = { logic: "AND" | "OR", rules: [...] }
 */
export function evaluateTabCondition(condition, studentProfile, submittedTabs = []) {
  const cond = parseTabCondition(condition);
  const { logic = 'AND', rules = [] } = cond;

  if (!rules.length) return true; // No rules = always visible

  const results = rules.map(rule => evaluateRule(rule, studentProfile, submittedTabs));

  return logic === 'OR'
    ? results.some(Boolean)
    : results.every(Boolean);
}

/**
 * Filter tabs by student visibility (based on conditions)
 */
export function filterTabsByStudent(tabs, studentProfile, submittedTabs = []) {
  return tabs.filter(tab => {
    // Must be enabled
    if (!tab.is_enabled) return false;

    // Evaluate condition
    return evaluateTabCondition(tab.condition_json, studentProfile, submittedTabs);
  });
}

/**
 * Validate submission data against tab field schema
 */
export function validateSubmissionData(tabFields, submissionData) {
  const errors = {};

  for (const field of tabFields) {
    if (field.type === 'group_label') continue; // Not a data field

    const value = submissionData?.[field.name];

    // Check required
    if (field.required && (!value || String(value).trim() === '')) {
      errors[field.name] = `${field.label || field.name} is required`;
      continue;
    }

    // Check regex pattern
    if (value && field.pattern) {
      try {
        const regex = new RegExp(field.pattern);
        if (!regex.test(String(value))) {
          errors[field.name] = `${field.label || field.name} format is invalid`;
        }
      } catch (e) {
        console.warn(`Invalid regex for field ${field.name}:`, e);
      }
    }

    // Type-specific validation
    if (value) {
      const strValue = String(value).trim();
      if (field.type === 'email' && !isValidEmail(strValue)) {
        errors[field.name] = 'Invalid email address';
      }
      if (field.type === 'url' && !isValidUrl(strValue)) {
        errors[field.name] = 'Invalid URL';
      }
      if (field.type === 'phone' && !isValidPhone(strValue)) {
        errors[field.name] = 'Invalid phone number';
      }
      if (field.type === 'date' && !isValidDate(strValue)) {
        errors[field.name] = 'Invalid date';
      }
      if (field.type === 'number' && isNaN(parseFloat(strValue))) {
        errors[field.name] = 'Must be a number';
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Helper validation functions
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 10 && cleaned.length <= 15;
}

function isValidDate(dateStr) {
  const date = new Date(dateStr);
  return date instanceof Date && !isNaN(date);
}

/**
 * Calculate form completion percentage
 */
export function calculateFormCompletion(tabFields, submissionData = {}) {
  const dataFields = tabFields.filter(f => f.type !== 'group_label');
  if (dataFields.length === 0) return 0;

  const filledCount = dataFields.filter(f => {
    const val = submissionData?.[f.name];
    return val && String(val).trim() !== '';
  }).length;

  return Math.round((filledCount / dataFields.length) * 100);
}

/**
 * Format field value for display (UI rendering)
 */
export function formatFieldValue(field, value) {
  if (!value && value !== 0) return '—';

  switch (field.type) {
    case 'date':
      return new Date(value).toLocaleDateString('en-BD');
    case 'currency':
      return `৳${parseFloat(value).toFixed(2)}`;
    case 'checkbox':
    case 'radio':
      return Array.isArray(value) ? value.join(', ') : value;
    default:
      return String(value);
  }
}

/**
 * Get field metadata for form rendering
 */
export function getFieldMetadata(field) {
  return {
    name: field.name,
    label: field.label || field.name,
    type: field.type,
    required: !!field.required,
    placeholder: field.placeholder || '',
    helpText: field.helpText || '',
    pattern: field.pattern,
    minLength: field.minLength,
    maxLength: field.maxLength,
    min: field.min,
    max: field.max,
    options: field.options || [], // For dropdown/radio/checkbox
    readOnly: !!field.readOnly,
    disabled: !!field.disabled,
  };
}

/**
 * Group fields by group_label for form layout
 */
export function groupFields(fields) {
  const groups = [];
  let currentGroup = { label: null, fields: [] };

  for (const field of fields) {
    if (field.type === 'group_label') {
      if (currentGroup.fields.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = { label: field.label || field.name, fields: [] };
    } else {
      currentGroup.fields.push(field);
    }
  }

  if (currentGroup.fields.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Parse include_fields_json (read-only fields to display from students_data)
 */
export function parseIncludeFields(includeFieldsJson) {
  try {
    const fields = typeof includeFieldsJson === 'string'
      ? JSON.parse(includeFieldsJson)
      : includeFieldsJson;
    return Array.isArray(fields) ? fields : [];
  } catch (e) {
    console.error('Failed to parse include_fields_json:', e);
    return [];
  }
}

export default {
  FIELD_TYPES,
  CONDITION_OPERATORS,
  validateField,
  parseTabFields,
  parseTabCondition,
  evaluateRule,
  evaluateTabCondition,
  filterTabsByStudent,
  validateSubmissionData,
  calculateFormCompletion,
  formatFieldValue,
  getFieldMetadata,
  groupFields,
  parseIncludeFields,
};
