/**
 * Form Renderer Module
 * Renders dynamic form fields based on tab configuration
 * Handles all field types: text, email, date, dropdown, checkbox, etc.
 */

import * as schema from './portal-schema.js';

/**
 * Render a single form field with label and input
 */
export function renderField(fieldDef, value = '', readOnly = false) {
  if (!fieldDef) return '';

  const {
    name,
    label,
    type,
    placeholder,
    required,
    pattern,
    minLength,
    maxLength,
    helpText,
    options = [],
  } = schema.getFieldMetadata(fieldDef);

  const fieldId = `field-${name}`;
  const reqMark = required ? '<span class="text-danger ms-1">*</span>' : '';
  const helpHtml = helpText ? `<small class="d-block text-muted mt-1">${helpText}</small>` : '';
  const dataKey = fieldDef.data_key || fieldDef.name;

  let inputHtml = '';

  switch (type) {
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
    case 'number':
    case 'currency':
      const inputType = {
        text: 'text',
        email: 'email',
        phone: 'tel',
        url: 'url',
        number: 'number',
        currency: 'number',
      }[type] || 'text';

      inputHtml = `<input
        type="${inputType}"
        id="${fieldId}"
        name="${dataKey}"
        class="form-control premium-field"
        placeholder="${placeholder || ''}"
        value="${escapeHtml(String(value || ''))}"
        ${required ? 'required' : ''}
        ${pattern ? `pattern="${pattern}"` : ''}
        ${minLength ? `minlength="${minLength}"` : ''}
        ${maxLength ? `maxlength="${maxLength}"` : ''}
        ${readOnly ? 'disabled' : ''}
        />`;
      break;

    case 'date':
      const dateVal = value ? new Date(value).toISOString().split('T')[0] : '';
      inputHtml = `<input
        type="date"
        id="${fieldId}"
        name="${dataKey}"
        class="form-control premium-field"
        value="${dateVal}"
        ${required ? 'required' : ''}
        ${readOnly ? 'disabled' : ''}
        />`;
      break;

    case 'textarea':
      inputHtml = `<textarea
        id="${fieldId}"
        name="${dataKey}"
        class="form-control premium-field"
        placeholder="${placeholder || ''}"
        rows="4"
        ${required ? 'required' : ''}
        ${readOnly ? 'disabled' : ''}
        >${escapeHtml(String(value || ''))}</textarea>`;
      break;

    case 'dropdown':
    case 'select':
      const selectedVal = String(value || '');
      const optionsHtml = (options || [])
        .map(opt => {
          const optVal = typeof opt === 'string' ? opt : opt.value || opt.label;
          const optLabel = typeof opt === 'string' ? opt : opt.label || opt.value;
          return `<option value="${optVal}" ${optVal === selectedVal ? 'selected' : ''}>${escapeHtml(String(optLabel))}</option>`;
        })
        .join('');
      inputHtml = `<select
        id="${fieldId}"
        name="${dataKey}"
        class="form-select premium-field"
        ${required ? 'required' : ''}
        ${readOnly ? 'disabled' : ''}
        >
        <option value="">— Select ${label} —</option>
        ${optionsHtml}
        </select>`;
      break;

    case 'checkbox':
      const checkboxVals = Array.isArray(value) ? value : (value ? String(value).split(',') : []);
      inputHtml = `<div class="premium-checkbox-group" id="${fieldId}">
        ${(options || [])
          .map((opt, i) => {
            const optVal = typeof opt === 'string' ? opt : opt.value || opt.label;
            const optLabel = typeof opt === 'string' ? opt : opt.label || opt.value;
            const chkId = `${fieldId}-${i}`;
            const isChecked = checkboxVals.includes(String(optVal));
            return `<label class="premium-checkbox-card">
              <input
                type="checkbox"
                id="${chkId}"
                name="${dataKey}"
                value="${optVal}"
                ${isChecked ? 'checked' : ''}
                ${readOnly ? 'disabled' : ''}
              />
              <span>${escapeHtml(String(optLabel))}</span>
            </label>`;
          })
          .join('')}
      </div>`;
      break;

    case 'radio':
      const radioVal = String(value || '');
      inputHtml = `<div class="premium-radio-group" id="${fieldId}">
        ${(options || [])
          .map((opt, i) => {
            const optVal = typeof opt === 'string' ? opt : opt.value || opt.label;
            const optLabel = typeof opt === 'string' ? opt : opt.label || opt.value;
            const radId = `${fieldId}-${i}`;
            return `<label class="form-check">
              <input
                type="radio"
                id="${radId}"
                name="${dataKey}"
                value="${optVal}"
                ${optVal === radioVal ? 'checked' : ''}
                ${readOnly ? 'disabled' : ''}
                class="form-check-input"
              />
              <span class="form-check-label">${escapeHtml(String(optLabel))}</span>
            </label>`;
          })
          .join('')}
      </div>`;
      break;

    case 'file':
      inputHtml = `<input
        type="file"
        id="${fieldId}"
        name="${dataKey}"
        class="form-control"
        ${readOnly ? 'disabled' : ''}
        />`;
      break;

    case 'group_label':
      return `<div class="col-12 mt-4"><h6 class="profile-group-label" style="color:var(--secondary)">${label}</h6></div>`;

    default:
      inputHtml = `<input
        type="text"
        id="${fieldId}"
        name="${dataKey}"
        class="form-control premium-field"
        placeholder="${placeholder || ''}"
        value="${escapeHtml(String(value || ''))}"
        ${readOnly ? 'disabled' : ''}
        />`;
  }

  // Wrap in form group
  return `<div class="premium-form-group">
    ${inputHtml}
    <label for="${fieldId}">${escapeHtml(label)}${reqMark}</label>
    ${helpHtml}
  </div>`;
}

/**
 * Render complete form for a tab
 */
export function renderTabForm(tab, studentData = {}, submittedData = {}, readOnly = false) {
  const tabId = `tab-${tab.tab_name}`;
  const fields = schema.parseTabFields(tab.fields_json || '[]');
  const inclKeys = schema.parseIncludeFields(tab.include_fields_json || '[]');

  const completion = schema.calculateFormCompletion(fields, submittedData);
  const groupedFields = schema.groupFields(fields);

  // Build form HTML
  let html = `<div class="card shadow-lg">
    <h2 class="h4 section-title">${escapeHtml(tab.tab_name)}</h2>`;

  // Locked badge
  if (readOnly) {
    html += `<div class="alert alert-info py-3 mb-4 rounded-4 shadow-sm border-0">
      <i class="bi bi-shield-check-fill me-2 fs-5"></i>Verified & Locked
    </div>`;
  }

  // Progress bar
  html += `<div class="tab-fill-progress" id="${tabId}-fill-progress">
    <div class="tab-fill-bar-bg">
      <div class="tab-fill-bar" style="width:${completion}%;background:${
        completion === 100 ? 'var(--primary)' : completion >= 50 ? '#f59e0b' : '#ef4444'
      }"></div>
    </div>
    <span class="tab-fill-label">${completion}% complete</span>
  </div>`;

  // Included profile fields (read-only)
  if (inclKeys.length > 0) {
    html += `<div class="include-master-info mt-4">
      <div class="small fw-800 text-muted text-uppercase mb-3" style="letter-spacing:0.07em;font-size:0.62rem">
        <i class="bi bi-person-badge me-1"></i>Student Profile Data
      </div>
      <div class="row g-3">`;

    inclKeys.forEach(key => {
      const val = studentData[key] || '—';
      html += `<div class="col-6 col-md-4">
        <div class="imi-label">${escapeHtml(String(key).replace(/_/g, ' '))}</div>
        <div class="imi-value">${escapeHtml(String(val))}</div>
      </div>`;
    });

    html += `</div></div>`;
  }

  // Form fields grouped
  html += `<form id="${tabId}-form" class="mt-4">
    <input type="hidden" name="tabName" value="${tab.tab_name}" />
    <div class="row g-4">`;

  groupedFields.forEach(group => {
    if (group.label) {
      html += `<div class="col-12 mt-3"><h6 class="profile-group-label">${escapeHtml(group.label)}</h6></div>`;
    }
    group.fields.forEach(field => {
      const val = submittedData[field.data_key || field.name] || studentData[field.data_key || field.name] || '';
      html += `<div class="col-md-6">${renderField(field, val, readOnly)}</div>`;
    });
  });

  html += `</div>`;

  // Submit button
  if (!readOnly) {
    html += `<button type="submit" class="btn btn-premium-save w-100 mt-5">
      <i class="bi bi-cloud-arrow-up-fill fs-5"></i> Sync & Save Information
    </button>`;
  }

  html += `<div class="status-msg text-center mt-3 small fw-bold"></div>
  </form></div>`;

  return html;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Get form data from form element
 */
export function getFormData(formElement) {
  if (!formElement) return {};

  const formData = new FormData(formElement);
  const data = {};

  for (const [key, value] of formData) {
    if (key === 'tabName') continue;

    // Handle multiple checkboxes with same name
    if (data[key]) {
      if (!Array.isArray(data[key])) {
        data[key] = [data[key]];
      }
      data[key].push(value);
    } else {
      data[key] = value;
    }
  }

  // Convert checkbox arrays to comma-separated strings
  Object.keys(data).forEach(key => {
    if (Array.isArray(data[key])) {
      data[key] = data[key].join(', ');
    }
  });

  return data;
}

/**
 * Validate form against field schema
 */
export function validateForm(fields, formData) {
  const validation = schema.validateSubmissionData(fields, formData);
  if (!validation.valid) {
    showFormErrors(validation.errors);
    return false;
  }
  return true;
}

/**
 * Show validation errors in form
 */
function showFormErrors(errors) {
  // Clear previous errors
  document.querySelectorAll('.form-error-msg').forEach(el => el.remove());
  document.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));

  // Add error classes and messages
  Object.entries(errors).forEach(([fieldName, errorMsg]) => {
    const field = document.querySelector(`[name="${fieldName}"]`);
    if (field) {
      field.classList.add('is-invalid');
      const errorEl = document.createElement('small');
      errorEl.className = 'form-error-msg d-block text-danger mt-1';
      errorEl.textContent = errorMsg;
      field.parentElement.appendChild(errorEl);
    }
  });
}

export default {
  renderField,
  renderTabForm,
  getFormData,
  validateForm,
};
